import { flightAwareDuration } from './shared'

// The `nodeCrash` and `recoverNode` scenarios. There is no central health
// authority to notice a dead node — peers just stop hearing its gossip
// heartbeats, and each forms (then converges on) the opinion that it's DOWN.
// Recovery is where hinted handoff pays off: nodes holding hints for the
// returned node stream them over. Payloads:
//   nodeCrash:   { node }
//   recoverNode: { node, replays: [{ fromNode, key, value, ts, tombstone, color }] }

const CRASH_STEPS = [
  {
    key: 'silent',
    ms: 2600,
    title: '1 · The node goes silent',
    blurb:
      'Power failure, kernel panic, someone unplugs the wrong cable. Nothing announces the failure — the node simply stops taking part in gossip. Its data is still on its disks; the machine just can’t be reached.',
  },
  {
    key: 'gossip',
    ms: 2800,
    title: '2 · Gossip notices the missing heartbeats',
    blurb:
      'Every second, each node gossips its state (including a heartbeat counter) with a few random peers. The dead node’s counter stops advancing, and each peer’s failure detector (phi-accrual: “how surprising is this silence?”) loses confidence in it. This is fully decentralized — no master, no health-check service.',
  },
  {
    key: 'down',
    ms: 2800,
    title: '3 · Marked DOWN across the cluster',
    blurb:
      'Peer by peer, the cluster converges on DOWN (compressed to one step here). Note what does NOT happen: no failover, no leader election, no data re-replication. The other replicas keep serving reads and writes for the shared keys; coordinators will store HINTS for writes this node misses.',
  },
]

const recoverSteps = (p) => {
  const steps = [
    {
      key: 'back',
      ms: 2600,
      title: '1 · The node comes back',
      blurb:
        'The machine reboots and rejoins gossip; its heartbeat counter starts advancing again and peers mark it UP. Its SSTables survived on disk — but its memtable died with the process, and it missed every write while it was gone.',
    },
  ]
  if (p.replays.length > 0) {
    steps.push({
      key: 'replay',
      ms: 2200, // overridden by duration() (hint-replay flights)
      title: '2 · Hinted handoff: the hints replay',
      blurb: `Nodes holding hints for it now deliver them: ${p.replays.length} stored mutation${p.replays.length === 1 ? '' : 's'} stream${p.replays.length === 1 ? 's' : ''} over, and the recovered node applies each through its normal write path (commit log + memtable). This is hinted handoff completing — the write it missed arrives late but intact. (Real hints expire after a window, e.g. 3h; a longer outage needs repair.)`,
    })
    steps.push({
      key: 'caught',
      ms: 2600,
      title: '3 · Caught up',
      blurb:
        'The node is UP and has the mutations it missed. Anything hints couldn’t cover (expired hints, coordinator itself died) is what anti-entropy REPAIR exists for — try it from the buttons on the left.',
    })
  } else {
    steps.push({
      key: 'caught',
      ms: 2600,
      title: '2 · Back in the ring',
      blurb:
        'No hints were waiting, so the node is immediately current for everything it owns (it missed no writes — or missed ones nobody hinted). It resumes serving its token ranges as if nothing happened.',
    })
  }
  return steps
}

export const nodeCrash = {
  type: 'nodeCrash',
  label: 'scenario: node crash',
  steps: CRASH_STEPS,

  derive(c, op) {
    const p = op.payload
    if (op.step >= 0) c.nodes[p.node] = { ...c.nodes[p.node], up: false }
  },

  extra(cluster, op) {
    const p = op.payload
    if (op.step === 1) return { focus: Object.keys(cluster.nodes).filter((n) => n !== p.node), flights: [] }
    return { focus: [p.node], flights: [] }
  },
}

export const recoverNode = {
  type: 'recoverNode',
  label: 'scenario: recover node',
  steps: recoverSteps,

  derive(c, op) {
    const s = op.step
    const p = op.payload
    if (s >= 0) c.nodes[p.node] = { ...c.nodes[p.node], up: true }
    if (p.replays.length > 0 && s >= 1) {
      const n = c.nodes[p.node]
      for (const h of p.replays) {
        const cur = n.memtable[h.key]
        // LWW guard: a hint never regresses a newer local version.
        if (!cur || h.ts > cur.ts) {
          n.memtable[h.key] = { value: h.value, ts: h.ts, tombstone: h.tombstone }
        }
        n.commitLog += 1
        // The holder discharges the delivered hint.
        const holder = c.nodes[h.fromNode]
        holder.hints = holder.hints.filter((x) => !(x.forNode === p.node && x.key === h.key && x.ts === h.ts))
      }
    }
  },

  extra(cluster, op) {
    const s = op.step
    const p = op.payload
    if (p.replays.length > 0 && s === 1) {
      return {
        focus: [p.node, ...new Set(p.replays.map((h) => h.fromNode))],
        flights: p.replays.map((h, i) => ({
          key: `recover:${p.node}:${i}`,
          tokens: [{ id: `hint-${p.node}-${i}`, term: h.tombstone ? '🪦 ' + h.key : h.key, color: h.color }],
          fromSel: `[data-fly="${h.fromNode}"]`,
          toSel: `[data-fly="${p.node}"]`,
        })),
      }
    }
    return { focus: [p.node], flights: [] }
  },

  duration: flightAwareDuration(),
}
