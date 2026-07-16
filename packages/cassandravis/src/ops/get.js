import { N_REPLICAS, CL_NAMES } from '../cluster'
import { flightMs, FLIGHT_PAD_MS, RING_WALK_STEP_MS } from '../timing'

// The `get` op: coordinator → hash + ring walk → query R replicas → resolve by
// newest timestamp (last-write-wins) → (read repair if they disagree) → return.
// Payload, built by App at start() time from the folded cluster so derive
// stays pure:
//   { key, r, id, color, coord, token, replicas, walk,
//     contacted: [nodeId],              // the first R live replicas
//     responses: [{ node, entry }],     // entry = {value,ts,tombstone} | null
//     winner,                           // newest entry among responses | null
//     repairs: [nodeId],                // contacted replicas that are stale
//     ok }                              // contacted.length >= r
export function getIdx(p) {
  const repair = p.ok && p.repairs.length > 0
  return { coord: 0, hash: 1, walk: 2, query: 3, resolve: 4, repair: repair ? 5 : -1, ret: repair ? 6 : 5 }
}

const fmtEntry = (e) =>
  e ? (e.tombstone ? `a tombstone (t${e.ts})` : `${e.value} (t${e.ts})`) : 'no data'

function makeSteps(p) {
  const r = CL_NAMES[p.r]
  const steps = [
    {
      key: 'coord',
      ms: 1600,
      title: '1 · Coordinator receives the query',
      blurb: `The client sends get(${p.key}) to ${p.coord} — the node its driver is connected to, which makes ${p.coord} the coordinator — with read consistency ${r}: it must hear from ${p.r} replica${p.r === 1 ? '' : 's'} before answering. Reads are coordinated by a peer too — still no leader.`,
    },
    {
      key: 'hash',
      ms: 1500,
      title: '2 · Hash the key onto the ring',
      blurb: `Same partitioner, same math as the write: hash(${p.key}) mod 64 = token ${p.token}. A read finds its replicas exactly the way a write did — that's why no lookup table is needed.`,
    },
    {
      key: 'walk',
      ms: 2200, // overridden by duration() (ring-walk sweep)
      title: `3 · Walk the ring for the replica set`,
      blurb: `Clockwise from token ${p.token}, the same ${N_REPLICAS} distinct physical nodes: ${p.replicas.join(', ')}. Any of them can serve this key.`,
    },
    {
      key: 'query',
      ms: 1500, // overridden by duration() (fan-out flight)
      title: `4 · Query ${p.r} replica${p.r === 1 ? '' : 's'} (R=${p.r})`,
      blurb: p.ok
        ? `The coordinator queries ${p.contacted.join(', ')}. Each runs its LOCAL read path: check the memtable first, then SSTables newest-first — consulting each SSTable's bloom filter to skip tables that can't contain the key. (Real Cassandra sends one full data read plus digest reads; we show full reads.)`
        : `The coordinator needs ${p.r} replicas for ${r}, but only ${p.contacted.length} ${p.contacted.length === 1 ? 'is' : 'are'} up${p.contacted.length ? ` (${p.contacted.join(', ')})` : ''}. It cannot meet the consistency level. (Real Cassandra knows this from gossip and fails fast with Unavailable, without querying anyone; we animate the attempt so you can see what's missing.)`,
    },
    {
      key: 'resolve',
      ms: 2800,
      title: p.ok ? '5 · Resolve by newest timestamp' : '5 · Cannot satisfy the consistency level',
      blurb: p.ok
        ? p.responses.every((x) => !x.entry)
          ? `No contacted replica has ${p.key} — the read resolves to "not found".`
          : `The responses come back: ${p.responses.map((x) => `${x.node} → ${fmtEntry(x.entry)}`).join(' · ')}. The coordinator picks the NEWEST timestamp — last-write-wins. ${p.winner?.tombstone ? `The winner is a tombstone, so the answer is "not found" — the delete out-timestamps any older value.` : `The winner is ${fmtEntry(p.winner)}.`}${p.repairs.length ? ' The replicas disagree — that gets fixed next.' : ''} (Cassandra resolves by timestamp; the Dynamo paper used vector clocks and returned siblings.)`
        : `Fewer than R=${p.r} replicas responded, so the read FAILS. Tunable consistency is a real trade: a lower R (ONE) would have succeeded here — at the risk of a stale answer.`,
    },
  ]
  if (p.ok && p.repairs.length > 0)
    steps.push({
      key: 'repair',
      ms: 2600,
      title: '6 · Read repair: fix the stale replicas',
      blurb: `${p.repairs.join(', ')} returned ${p.repairs.length === 1 ? 'a stale copy' : 'stale copies'}, so the coordinator writes the winning version (t${p.winner.ts}) back to ${p.repairs.length === 1 ? 'it' : 'them'} before answering. Reads quietly heal the data they touch — one of the anti-entropy mechanisms (hints and repair are the others).`,
    })
  steps.push({
    key: 'ret',
    ms: 2400,
    title: `${steps.length + 1} · Return to the client`,
    blurb: p.ok
      ? p.winner && !p.winner.tombstone
        ? `The client gets ${p.winner.value}. With W+R > N (quorum overlap), at least one contacted replica was in the latest successful write's quorum — that's the consistency guarantee. With W+R ≤ N (e.g. ONE/ONE), this read could legitimately have been stale.`
        : `The client gets "not found"${p.winner?.tombstone ? ' — the newest version is a tombstone' : ''}.`
      : `The client gets an error (Unavailable). Note what did NOT happen: no failover, no leader election — the data is still there; this read just demanded more replicas than are currently up.`,
  })
  return steps
}

export default {
  type: 'get',
  label: 'Get (read)',
  steps: makeSteps,

  // Read repair is the only committed-state change a read can make.
  derive(c, op) {
    const p = op.payload
    const idx = getIdx(p)
    if (idx.repair >= 0 && op.step >= idx.repair) {
      for (const nid of p.repairs) {
        const n = c.nodes[nid]
        n.memtable[p.key] = { ...p.winner }
        n.commitLog += 1
      }
    }
  },

  extra(cluster, op) {
    const s = op.step
    const p = op.payload
    const idx = getIdx(p)
    const chip = { id: `get-${p.id}`, term: p.key + '?', color: p.color }

    const ring =
      s >= idx.hash
        ? { token: p.token, walk: p.walk, walking: s === idx.walk, settled: s > idx.walk }
        : null

    let focus = []
    let flights = []
    if (s === idx.coord) {
      focus = [p.coord]
      flights = [
        {
          key: `get:${p.id}:coord`,
          tokens: [chip],
          fromSel: '[data-fly="client"]',
          toSel: `[data-fly="${p.coord}"]`,
        },
      ]
    } else if (s === idx.walk) {
      focus = p.replicas
    } else if (s === idx.query) {
      focus = p.contacted
      flights = p.contacted.map((nid, i) => ({
        key: `get:${p.id}:q:${i}`,
        tokens: [{ ...chip, id: chip.id + ':q' + i }],
        fromSel: `[data-fly="${p.coord}"]`,
        toSel: `[data-fly="${nid}"]`,
      }))
    } else if (s === idx.resolve && p.ok) {
      focus = [p.coord]
      flights = p.responses.map((resp, i) => ({
        key: `get:${p.id}:r:${i}`,
        tokens: [
          {
            id: chip.id + ':r' + i,
            term: resp.entry ? (resp.entry.tombstone ? `🪦 t${resp.entry.ts}` : `${resp.entry.value} t${resp.entry.ts}`) : '∅',
            color: p.color,
          },
        ],
        fromSel: `[data-fly="${resp.node}"]`,
        toSel: `[data-fly="${p.coord}"]`,
      }))
    } else if (s === idx.repair && idx.repair >= 0) {
      focus = p.repairs
      flights = p.repairs.map((nid, i) => ({
        key: `get:${p.id}:rr:${i}`,
        tokens: [
          {
            id: chip.id + ':rr' + i,
            term: p.winner.tombstone ? `🪦 t${p.winner.ts}` : `${p.winner.value} t${p.winner.ts}`,
            color: p.color,
          },
        ],
        fromSel: `[data-fly="${p.coord}"]`,
        toSel: `[data-fly="${nid}"]`,
      }))
    } else if (s === idx.ret) {
      focus = [p.coord]
      flights = [
        {
          key: `get:${p.id}:ret`,
          tokens: [
            {
              id: chip.id + ':ret',
              term: p.ok ? (p.winner && !p.winner.tombstone ? p.winner.value : '∅ not found') : '✗ unavailable',
              color: p.ok && p.winner && !p.winner.tombstone ? p.color : p.ok ? '#667' : '#b0413e',
            },
          ],
          fromSel: `[data-fly="${p.coord}"]`,
          toSel: '[data-fly="client"]',
        },
      ]
    }

    const quorum = {
      kind: 'read',
      r: p.r,
      ok: p.ok,
      revealed: s >= idx.resolve,
      verdict: s >= idx.resolve,
      repaired: idx.repair >= 0 && s >= idx.repair,
      responses: p.responses,
      winner: p.winner,
      repairs: p.repairs,
      contacted: p.contacted,
      replicas: p.replicas.map((nid) => ({
        node: nid,
        down: !cluster.nodes[nid].up,
        contacted: p.contacted.includes(nid),
      })),
    }

    return { ring, focus, flights, quorum }
  },

  duration(op, extra) {
    const p = op.payload
    const idx = getIdx(p)
    if (op.step === idx.walk) return RING_WALK_STEP_MS * p.walk.length + FLIGHT_PAD_MS
    const flights = extra.flights ?? []
    if (flights.length > 0) {
      const longest = Math.max(...flights.map((f) => f.tokens.length))
      return 1500 + flightMs(longest) + FLIGHT_PAD_MS
    }
    return undefined
  },
}
