// Declarative script for the first-run guided tour. Each step spotlights a
// real control and advances when the user actually uses it (`advanceOn`), not
// via a Next button — only the centered welcome/finish cards (target: null)
// advance manually. `waitFor` gates VISIBILITY only: while false the tour
// renders nothing, which is how it waits out op animations and lets the app's
// own "What's happening" panel narrate. Predicates read the snapshot App
// builds: { opType, opStep, playing, opDone, downCount, sampleLoaded }.
export const TOUR_STEPS = [
  {
    id: 'welcome',
    target: null,
    title: 'Welcome to the Cassandra Cluster Visualizer',
    body: [
      'This app shows how a leaderless, Dynamo-style NoSQL store — Apache Cassandra — replicates and stores data: the consistent-hashing ring, tunable quorums, hinted handoff, and each node’s LSM tree. All simulated right here in your browser.',
      'Take the two-minute tour? You will write a key, read it back, crash a node, and watch the cluster heal itself.',
    ],
    cta: 'Start the tour',
    secondary: 'Skip for now',
  },
  {
    id: 'put',
    target: '[data-tour="put-area"]',
    placement: 'right',
    title: 'Put your first key',
    body: 'Keep the preset (or type your own key and value) and click “Put”. Watch the key hash onto the ring, the coordinator walk clockwise for 3 distinct replicas, and the write fan out to ALL of them — W only controls how many acks it waits for.',
    advanceOn: (s) => s.opType === 'put',
  },
  {
    id: 'get',
    target: '[data-tour="get-btn"]',
    placement: 'right',
    title: 'Read it back',
    body: 'Now click “Get”. The same hash finds the same replicas; the coordinator queries R of them and resolves by newest timestamp. When replicas are contacted, a 🔍 appears on their cards — click it to zoom into a node’s local read path (memtable → SSTables → bloom filters).',
    waitFor: (s) => s.opType === 'put' && s.opDone && !s.playing,
    advanceOn: (s) => s.opType === 'get',
  },
  {
    id: 'crash',
    target: '[data-tour="scenario-crash"]',
    placement: 'bottom',
    title: 'Now break something',
    body: 'Click “💥 crash a node”. One of your key’s replicas goes silent — no announcement, just missing gossip heartbeats. Watch the cluster converge on DOWN with no failover and no leader election.',
    waitFor: (s) => s.opType === 'get' && s.opDone && !s.playing,
    advanceOn: (s) => s.downCount > 0,
  },
  {
    id: 'hint-put',
    target: '[data-tour="put-area"]',
    placement: 'right',
    title: 'Write through the failure',
    body: 'Put the same key again (maybe a new value). The write still goes to all 3 replicas — but one is down, so the coordinator stores a HINT for it. Note the quorum math: hints don’t count toward W.',
    waitFor: (s) => s.opType === 'nodeCrash' && s.opDone && !s.playing,
    advanceOn: (s) => (s.opType === 'put' || s.opType === 'del') && s.downCount > 0,
  },
  {
    id: 'recover',
    target: '[data-tour="scenario-recover"]',
    placement: 'bottom',
    title: 'Bring it back',
    body: 'Click “🔌 recover node”. The node rejoins gossip and the stored hint replays — the write it missed arrives late but intact. That’s hinted handoff completing.',
    waitFor: (s) => (s.opType === 'put' || s.opType === 'del') && s.opDone && !s.playing,
    advanceOn: (s) => s.opType === 'recoverNode',
  },
  {
    id: 'finish',
    target: null,
    title: 'That’s the core loop!',
    body: [
      'You wrote at W, read at R, crashed a replica, wrote through the failure, and healed it with hinted handoff — all without a leader anywhere.',
      'Keep going: try Flush and Compact to see the LSM tree, Delete to see tombstones, ONE/ONE to catch a stale read, and Repair to watch Merkle trees find divergence. “Load sample data” seeds a lived-in cluster (with one deliberately stale replica).',
    ],
    waitFor: (s) => s.opType === 'recoverNode' && s.opDone,
    cta: 'Done',
  },
]
