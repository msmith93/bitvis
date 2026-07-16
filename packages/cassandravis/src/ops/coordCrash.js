// The `coordCrash` scenario: the coordinator itself dies. This is the app's
// leaderless showcase — the moment a leader-based store would run an election,
// Cassandra's client driver just connects to another live peer and THAT node
// coordinates from now on. Payload: { node, next } — the dying coordinator and
// the peer the driver falls back to, both picked by App at start().
const makeSteps = (p) => [
  {
    key: 'silent',
    ms: 2600,
    title: '1 · The coordinator goes silent',
    blurb: `${p.node} — the node this client's driver is connected to, the one coordinating every request so far — stops mid-heartbeat. Nothing announces it. If ${p.node} were a LEADER, the node that owns writes would have just vanished. Watch what actually happens instead.`,
  },
  {
    key: 'down',
    ms: 2800,
    title: '2 · Gossip converges on DOWN — and nothing gets elected',
    blurb: `Peers stop seeing ${p.node}'s heartbeats and converge on DOWN, exactly as for any node. In a leader-based store THIS is the expensive moment: detect the loss, run an ELECTION, promote a follower — and writes stall until it finishes. Here, nothing of the sort starts, because there is nothing to elect: ${p.node} never owned anything the other replicas don't also have.`,
  },
  {
    key: 'reroute',
    ms: 3000,
    title: `3 · The driver just picks the next peer: ${p.next}`,
    blurb: `The client's driver already knows every node in the cluster. Its connection to ${p.node} died, so it opens one to ${p.next} — and ${p.next} is now "the coordinator", purely because it's the node being talked to. No promotion, no handover, no pause. (${p.node}'s replica copies get healed later by hints and repair, like any crashed node — and when it returns, the client keeps THIS connection: coordinator is not a role to win back.)`,
  },
]

export default {
  type: 'coordCrash',
  label: 'scenario: coordinator crash',
  steps: makeSteps,

  derive(c, op) {
    const p = op.payload
    if (op.step >= 0) c.nodes[p.node] = { ...c.nodes[p.node], up: false }
    if (op.step >= 2) c.coordinator = p.next
  },

  extra(cluster, op) {
    const p = op.payload
    // Same silent-then-DOWN staging as nodeCrash: no DOWN banner while the
    // narration is still "gossip noticing".
    const crash = { node: p.node, silent: op.step < 2 }
    if (op.step === 1)
      return { focus: Object.keys(cluster.nodes).filter((n) => n !== p.node), flights: [], crash }
    if (op.step === 2)
      return {
        focus: [p.next],
        flights: [
          {
            key: `coordCrash:${p.node}:reroute`,
            tokens: [{ id: `reroute-${p.next}`, term: '🔌 connect', color: '#1287b1' }],
            fromSel: '[data-fly="client"]',
            toSel: `[data-fly="${p.next}"]`,
          },
        ],
        crash,
      }
    return { focus: [p.node], flights: [], crash }
  },
}
