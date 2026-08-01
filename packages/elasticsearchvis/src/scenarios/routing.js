// "How does a routing key work?"
//
// Runs the SAME query twice against the same data — once with a routing key and
// once without — so the only thing that changes on the stage is how many shards
// light up. The dataset is loaded with explicit routing keys, which is the part
// that makes it possible: a search can skip shards only because indexing already
// guaranteed the data cannot be on them.
const STEPS = [
  {
    id: 'welcome',
    target: null,
    title: 'How does a routing key work?',
    body: [
      'By default a document’s shard comes from hash(_id), so a tenant’s documents get sprayed across every shard — and every search has to ask all of them.',
      'Give the document a routing key and the shard comes from hash(routing) instead. Everything sharing a key lands on one shard, so a search that supplies the same key can go straight there.',
      'You will run one query twice — with the key and without — and watch how much of the cluster wakes up each time, and how much work the coordinator is left holding at the end.',
    ],
    cta: 'Show me',
    secondary: 'Skip for now',
  },
  {
    id: 'load',
    target: '[data-tour="load-routed"]',
    placement: 'right',
    title: 'Load data that was indexed with routing',
    body: 'Click “Load routed docs”. Nine orders for three tenants, each indexed with its tenant as the routing key. Every tenant gets its own colour on the stage — notice that one colour never appears on more than one shard, no matter what the _ids are.',
    advanceOn: (s) => s.sampleSet === 'routed',
  },
  {
    id: 'run-routed',
    target: '[data-tour="search-area"]',
    placement: 'right',
    title: 'Search WITH the routing key',
    body: 'We have filled in the query “order” and the routing key “tenant-a”. Hit Search and keep your eye on the cluster.',
    onShow: (s, actions) => {
      actions.setQuery('order')
      actions.setRouting('tenant-a')
    },
    advanceOn: (s) => s.opRouting === 'tenant-a',
  },
  {
    id: 'watch-routed',
    target: '[data-tour="cluster"]',
    placement: 'left',
    title: 'One shard. That’s it.',
    waitFor: (s) => s.opRouting === 'tenant-a' && s.opStepsDone.includes('scatter'),
    onShow: (s, actions) => actions.pause(),
    body: 'The coordinator hashed “tenant-a” to a single shard and sent the query only there. The other two shards were never asked — no CPU, no disk, no top-k merge for them. In a big cluster that is the difference between one node working and all of them.',
    cta: 'Got it',
  },
  {
    id: 'resume-routed',
    target: '[data-tour="stepper-play"]',
    placement: 'top',
    title: 'Watch it come back',
    body: 'Press ▶ Play to let the query phase finish, and we will stop again once the shard has reported in.',
    waitFor: (s) => s.zoomShard == null && !s.coordZoom,
    highlightPlay: true,
    // Hands over to the coordinator step, which pauses as soon as the gather
    // phase renders (same handoff as the intro tour's stepper → coord-magnify).
    advanceOn: (s) => s.playing || s.opStepsDone.includes('gather'),
  },
  {
    id: 'coord-routed',
    target: '[data-tour="coord-magnify"]',
    placement: 'bottom',
    title: 'One list to merge',
    waitFor: (s) =>
      s.opRouting === 'tenant-a' && s.opStepKey === 'gather' && s.zoomShard == null,
    onShow: (s, actions) => actions.pause(),
    body: 'Now click the 🔍 on the coordinator. Every hit it is holding carries the same address — shard 1 — because only one shard was ever asked. There is a single short list to rank, no cross-shard merge, and nothing to wait on.',
    advanceOn: (s) => s.coordZoom || (s.opDone && !s.playing),
  },
  {
    id: 'finish-routed',
    target: '[data-tour="stepper-play"]',
    placement: 'top',
    title: 'Run it out',
    body: 'Press ▶ Play to finish the routed search, and we will run the very same query again without the key.',
    waitFor: (s) => s.zoomShard == null && !s.coordZoom,
    highlightPlay: true,
    advanceOn: (s) => s.opType === 'search' && s.opDone && !s.playing,
  },
  {
    id: 'run-unrouted',
    target: '[data-tour="search-area"]',
    placement: 'right',
    title: 'Now clear the routing key',
    body: 'We have emptied the routing field — same query, no key. Hit Search again.',
    waitFor: (s) => s.zoomShard == null && !s.coordZoom,
    onShow: (s, actions) => actions.setRouting(''),
    advanceOn: (s) => s.opType === 'search' && !s.opRouting && !s.opDone,
  },
  {
    id: 'watch-unrouted',
    target: '[data-tour="cluster"]',
    placement: 'left',
    title: 'Now everybody works',
    waitFor: (s) => !s.opRouting && s.opType === 'search' && s.opStepsDone.includes('scatter'),
    onShow: (s, actions) => actions.pause(),
    body: 'Without the key the coordinator has no idea which shard could hold “tenant-a” data, so it must scatter to all three and merge whatever comes back. Same query, same results — three times the cluster work.',
    cta: 'Got it',
  },
  {
    id: 'resume-unrouted',
    target: '[data-tour="stepper-play"]',
    placement: 'top',
    title: 'Watch them all come back',
    body: 'Press ▶ Play again. We will stop at the same moment as last time — once every shard has reported in.',
    waitFor: (s) => s.zoomShard == null && !s.coordZoom,
    highlightPlay: true,
    advanceOn: (s) => s.playing || s.opStepsDone.includes('gather'),
  },
  {
    id: 'coord-unrouted',
    target: '[data-tour="coord-magnify"]',
    placement: 'bottom',
    title: 'Three lists to merge',
    waitFor: (s) => !s.opRouting && s.opStepKey === 'gather' && s.zoomShard == null,
    onShow: (s, actions) => actions.pause(),
    body: 'Open the coordinator’s 🔍 once more. This time hits arrive from all three shards, and the coordinator has to interleave them into one global ranking before it can decide what to fetch. Compare the arrivals with the routed run: same query, same winners, three times the lists — and the response can only be as fast as the slowest shard.',
    advanceOn: (s) => s.coordZoom || (s.opDone && !s.playing),
  },
  {
    id: 'finish-unrouted',
    target: '[data-tour="stepper-play"]',
    placement: 'top',
    title: 'Run it out',
    body: 'Press ▶ Play one last time to let the unrouted search return its results.',
    waitFor: (s) => s.zoomShard == null && !s.coordZoom,
    highlightPlay: true,
    advanceOn: (s) => s.opType === 'search' && s.opDone && !s.playing,
  },
  {
    id: 'finish',
    target: null,
    title: 'The catch',
    body: [
      'Routing is supplied at INDEX time and at QUERY time, and both have to agree — index with a key and search without it and you fall back to scattering; search with the wrong key and you find nothing at all.',
      'The cost is balance: every document sharing a key shares a shard, so one big tenant becomes one hot, oversized shard while the rest idle. Routing trades even distribution for cheap, targeted queries.',
      'Try it yourself: the routing field next to the search box works on any dataset, and the index form takes a routing key too — type one and watch the predicted target shard change before you index.',
    ],
    waitFor: (s) => s.zoomShard == null && !s.coordZoom,
    cta: 'Done',
  },
]

export default {
  id: 'routing',
  label: 'How a routing key works',
  blurb:
    'The same query with and without a routing key: one shard versus all three, and one list to merge versus three.',
  steps: STEPS,
  setup: (actions) => actions.reset(),
}
