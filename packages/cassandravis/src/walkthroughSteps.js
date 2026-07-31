// Declarative script for the first-run guided tour. Each step spotlights a
// real control and advances when the user actually uses it (`advanceOn`), not
// via a Next button — only the centered welcome/finish cards (target: null)
// advance manually. `waitFor` gates VISIBILITY only: while false the tour
// renders nothing, which is how it waits out op animations and lets the app's
// own "What's happening" panel narrate. `onShow` fires once when a step first
// becomes visible (the magnify step uses it to pause mid-op, same as
// elasticsearchvis). Predicates read the snapshot App builds:
// { opType, opStep, playing, opDone, downCount, sampleLoaded, closeUpKind, key }.
export const TOUR_STEPS = [
  {
    id: 'welcome',
    target: null,
    title: 'Welcome to the Cassandra Cluster Visualizer',
    body: [
      'This app shows how a leaderless, Dynamo-style NoSQL store — Apache Cassandra — replicates and stores data: the consistent-hashing ring, tunable quorums, hinted handoff, and each node’s LSM tree. All simulated right here in your browser.',
      'One tip before you start: wherever you see the 🔍 magnifying glass, you can click it to zoom into a much more granular view of what a node — or the coordinator — is doing.',
      'Take the two-minute tour? You will write a key, read it back through a replica’s storage engine, crash a node, and watch the cluster heal itself.',
    ],
    cta: 'Start the tour',
    secondary: 'Skip for now',
  },
  {
    id: 'put',
    target: '[data-tour="put-btn"]',
    placement: 'right',
    title: 'Put your first key',
    body: 'Click “Put” to write the preset key. Watch it hash onto the ring, the coordinator walk clockwise for 3 distinct replicas, and the write fan out to ALL of them — W only controls how many acks it waits for.',
    advanceOn: (s) => s.opType === 'put',
  },
  {
    id: 'put-magnify',
    target: '[data-tour="magnify"]',
    placement: 'bottom',
    title: 'Zoom into a replica’s write path',
    // Same pause trick as the read-side magnify step below: cancel the
    // auto-play clock so the transient 🔍 stays mounted while the user reads.
    waitFor: (s) => s.opType === 'put' && s.opStep === 3,
    onShow: (s, actions) => actions.pause(),
    body: 'The write is paused mid-flight: each replica is applying the mutation locally right now. Click the highlighted 🔍 to step through it — the commit-log append (durability) and the memtable upsert.',
    advanceOn: (s) => s.closeUpKind === 'writepath' || (s.opDone && !s.playing),
  },
  {
    id: 'put-stepper',
    target: '[data-tour="stepper-play"]',
    placement: 'top',
    title: 'Resume the write',
    body: 'The write is still paused mid-flight. Press ▶ Play to resume it — watch the acks fly back and the coordinator count them against W.',
    // Hidden while the close-up is open so it never covers it. The opStep
    // escape hatch covers a user who scrubs forward with Next instead.
    waitFor: (s) => s.closeUpKind == null,
    advanceOn: (s) => s.playing || (s.opType === 'put' && s.opStep >= 4),
  },
  {
    id: 'load-sample',
    target: '[data-tour="load-sample"]',
    placement: 'right',
    title: 'Load a richer dataset',
    body: 'One key makes for a lonely cluster. Click “Load sample data” to seed a lived-in one: flushed SSTables, newer versions in memtables — and one deliberately STALE replica (node-1 missed a write to cart:7). The read you run next will catch it.',
    waitFor: (s) => s.opType === 'put' && s.opDone && !s.playing,
    advanceOn: (s) => s.sampleLoaded,
  },
  {
    id: 'get-key',
    target: '[data-tour="preset-cart7"]',
    placement: 'right',
    title: 'Pick the stale key',
    body: 'Click the cart:7 preset — the key whose write node-1 deliberately missed. The read you run next will have to deal with that.',
    waitFor: (s) => s.sampleLoaded && !s.playing,
    advanceOn: (s) => s.key === 'cart:7',
  },
  {
    id: 'get',
    target: '[data-tour="get-btn"]',
    placement: 'right',
    title: 'Now read it back',
    body: 'Click “Get”. The same hash finds the same replicas; the coordinator queries R of them and resolves by newest timestamp — and remember, one replica holds a stale cart:7.',
    waitFor: (s) => s.sampleLoaded && !s.playing,
    advanceOn: (s) => s.opType === 'get',
  },
  {
    id: 'magnify',
    target: '[data-tour="magnify"]',
    placement: 'bottom',
    title: 'Zoom into a replica',
    // Pausing here cancels the auto-play clock so the transient 🔍 stays
    // mounted while the user reads. The advanceOn escape hatch covers a user
    // who presses ▶ Play instead of clicking the magnifier.
    waitFor: (s) => s.opType === 'get' && s.opStep === 3,
    onShow: (s, actions) => actions.pause(),
    body: 'The read is paused mid-flight: each contacted replica is running its LOCAL read path right now. Click the highlighted 🔍 to step through it — the memtable (a real sorted map), each SSTable’s bloom filter, and the timestamp race that picks the answer.',
    advanceOn: (s) => s.closeUpKind === 'readpath' || (s.opDone && !s.playing),
  },
  {
    id: 'stepper',
    target: '[data-tour="stepper-play"]',
    placement: 'top',
    title: 'Resume the read',
    body: 'The read is still paused mid-flight. Press ▶ Play to resume it — watch the replicas’ answers fly back, last-write-wins pick the newest, and read repair quietly fix the stale copy.',
    // Hidden while the close-up is open so it never covers it. The opStep
    // escape hatch covers a user who scrubs forward with Next instead.
    waitFor: (s) => s.closeUpKind == null,
    advanceOn: (s) => s.playing || (s.opType === 'get' && s.opStep >= 4),
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
    target: '[data-tour="put-btn"]',
    placement: 'right',
    title: 'Write through the failure',
    body: 'Put the same key again. The write still goes to all 3 replicas — but one is down, so the coordinator stores a HINT for it. Note the quorum math: hints don’t count toward W.',
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
      'You wrote at W, zoomed inside a replica’s write and read paths, crashed a node, wrote through the failure, and healed it with hinted handoff — all without a leader anywhere.',
      'Remember the 🔍 magnifiers — every operation has them: the quorum math during a Put, flush and compaction inside the LSM tree, a peer’s failure detector during a crash, Merkle trees during Repair.',
    ],
    waitFor: (s) => s.opType === 'recoverNode' && s.opDone,
    cta: 'Done',
  },
]
