import { N_REPLICAS, CL_NAMES } from '../cluster'
import { flightMs, FLIGHT_PAD_MS, RING_WALK_STEP_MS } from '../timing'

// The shared write path: `put` and `del` are the same op with different
// mutation contents (a delete IS a write — of a tombstone). Payload, built by
// App at start() time so derive stays pure:
//   { key, value, ts, tombstone, color, w,        // the mutation + write CL
//     coord,                                       // cluster.coordinator at start
//     token, replicas, walk,                       // replicaWalk() result
//     down: [nodeId],                              // replicas down at start
//     acks,                                        // live replica count
//     ok }                                         // acks >= w
//
// Step indices are payload-dependent (the hint step only exists when a replica
// is down), so every consumer goes through stepIdx(payload).
export function stepIdx(p) {
  const hint = p.down.length > 0
  return { coord: 0, hash: 1, walk: 2, write: 3, hint: hint ? 4 : -1, ack: hint ? 5 : 4 }
}

export function makeWriteSteps(verb) {
  return (p) => {
    const w = CL_NAMES[p.w]
    const steps = [
      {
        key: 'coord',
        ms: 1600,
        title: '1 · Coordinator receives the request',
        blurb: `The client sends ${verb === 'delete' ? `delete(${p.key})` : `put(${p.key}, ${p.value})`} to ${p.coord} — the node its driver is connected to — with write consistency ${w}. That connection is ALL that makes ${p.coord} the coordinator: any node can coordinate; there is NO leader or primary in this cluster. The coordinator stamps the mutation with a timestamp (t${p.ts}); timestamps decide conflicts later (last-write-wins).${verb === 'delete' ? ' A delete is just a write whose payload is a TOMBSTONE marker.' : ''}`,
      },
      {
        key: 'hash',
        ms: 1700,
        title: '2 · Hash the key onto the ring',
        blurb: `The partitioner hashes the key: hash(${p.key}) mod 64 = token ${p.token}. That position on the ring — not any lookup table — determines which nodes own this key.`,
      },
      {
        key: 'walk',
        ms: 2200, // overridden by duration() (ring-walk sweep)
        title: `3 · Walk the ring for ${N_REPLICAS} replicas`,
        blurb: `Starting at token ${p.token} and walking clockwise, the first ${N_REPLICAS} DISTINCT physical nodes become the replica set: ${p.replicas.join(', ')}.${p.walk.some((s) => !s.taken) ? ' Note the skip: a vnode belonging to an already-chosen node does not count twice.' : ''} Each node owns several small ranges (vnodes), which spreads load when nodes join or leave.`,
      },
      {
        key: 'write',
        ms: 1500, // overridden by duration() (fan-out flight)
        title: `4 · Send to ALL ${N_REPLICAS} replicas in parallel`,
        blurb: `The coordinator forwards the ${verb === 'delete' ? 'tombstone' : 'mutation'} to ALL ${N_REPLICAS} replicas — never just ${CL_NAMES[p.w]}. Consistency level only controls how many acks it WAITS for. Each live replica appends the mutation to its commit log (durability) and writes it into its in-memory memtable.${p.down.length ? ` ${p.down.join(', ')} is DOWN and cannot respond.` : ''}`,
      },
    ]
    if (p.down.length > 0)
      steps.push({
        key: 'hint',
        ms: 2600,
        title: `5 · Store a hint for the down replica`,
        blurb: `The coordinator can't reach ${p.down.join(', ')}, so it stores a HINT locally: "when ${p.down.join(', ')} comes back, deliver this mutation." That's hinted handoff. Crucially, a hint does NOT count toward W — Cassandra keeps a strict quorum. (Dynamo differs: its sloppy quorum counts writes accepted by stand-in nodes.)`,
      })
    steps.push({
      key: 'ack',
      ms: 2600,
      title: `${steps.length + 1} · Count acks: ${p.acks} of ${p.w} needed (${w})`,
      blurb: p.ok
        ? `${p.acks} live replica${p.acks === 1 ? '' : 's'} acknowledged — that meets W=${p.w} (${w}), so the coordinator acks the client. Replication to any remaining replicas continues in the background; the client never waits for all ${N_REPLICAS} unless it asked for ALL.`
        : `Only ${p.acks} live replica${p.acks === 1 ? '' : 's'} could acknowledge — fewer than W=${p.w} (${w}), so the write FAILS back to the client. (Real Cassandra, already knowing via gossip that too few replicas are up, would fail fast with Unavailable before writing anything or storing a hint; what you see here is how a write that fails mid-flight by TIMEOUT behaves.) Either way the key lesson holds: there is no rollback. Replicas that did accept it keep it, and a later read may still see this "failed" write.`,
    })
    return steps
  }
}

export function deriveWrite(c, op) {
  const s = op.step
  const p = op.payload
  const idx = stepIdx(p)
  if (!c.keys[p.key]) c.keys[p.key] = { color: p.color }
  if (s >= idx.write) {
    for (const nid of p.replicas) {
      if (p.down.includes(nid)) continue
      const n = c.nodes[nid]
      n.memtable[p.key] = { value: p.value, ts: p.ts, tombstone: p.tombstone }
      n.commitLog += 1
    }
  }
  if (idx.hint >= 0 && s >= idx.hint) {
    const coord = c.nodes[p.coord]
    for (const nid of p.down)
      coord.hints.push({
        forNode: nid,
        key: p.key,
        value: p.value,
        ts: p.ts,
        tombstone: p.tombstone,
      })
  }
}

export function writeExtra(cluster, op) {
  const s = op.step
  const p = op.payload
  const idx = stepIdx(p)
  const chip = { id: `${op.type}-${p.ts}`, term: p.tombstone ? '✕ ' + p.key : p.key, color: p.color }

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
        key: `${op.type}:${p.ts}:coord`,
        tokens: [chip],
        fromSel: '[data-fly="client"]',
        toSel: `[data-fly="${p.coord}"]`,
      },
    ]
  } else if (s === idx.walk) {
    focus = p.replicas
  } else if (s === idx.write) {
    focus = p.replicas
    flights = p.replicas.map((nid, i) => ({
      key: `${op.type}:${p.ts}:w:${i}`,
      tokens: [{ ...chip, id: chip.id + ':' + i }],
      fromSel: `[data-fly="${p.coord}"]`,
      toSel: `[data-fly="${nid}"]`,
    }))
  } else if (s === idx.hint && idx.hint >= 0) {
    focus = [p.coord]
  } else if (s === idx.ack) {
    focus = [p.coord]
    flights = [
      {
        key: `${op.type}:${p.ts}:ack`,
        tokens: [
          {
            id: chip.id + ':ack',
            term: p.ok ? '✓ ack' : '✗ fail',
            color: p.ok ? '#2e7d4f' : '#b0413e',
          },
        ],
        fromSel: `[data-fly="${p.coord}"]`,
        toSel: '[data-fly="client"]',
      },
    ]
  }

  // Per-replica ack status for the quorum panel, revealed step by step.
  const quorum = {
    kind: 'write',
    w: p.w,
    ok: p.ok,
    acks: p.acks,
    revealed: s >= idx.write,
    verdict: s >= idx.ack,
    hinted: idx.hint >= 0 && s >= idx.hint,
    replicas: p.replicas.map((nid) => ({ node: nid, down: p.down.includes(nid) })),
  }

  return { ring, focus, flights, quorum }
}

export function writeDuration(op, extra) {
  const p = op.payload
  const idx = stepIdx(p)
  if (op.step === idx.walk) return RING_WALK_STEP_MS * p.walk.length + FLIGHT_PAD_MS
  const flights = extra.flights ?? []
  if (flights.length > 0) {
    const longest = Math.max(...flights.map((f) => f.tokens.length))
    return 1500 + flightMs(longest) + FLIGHT_PAD_MS
  }
  return undefined
}
