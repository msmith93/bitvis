// Declarative script for the first-run guided tour. Each step spotlights a real
// control and advances when the user actually uses it (`advanceOn`), not via a
// Next button — only the centered welcome/finish cards (target: null) advance
// manually. `waitFor` gates VISIBILITY only: while false the tour renders
// nothing, which is how it waits out op animations and lets the app's own
// "What's happening" panel narrate. Predicates read the snapshot App builds:
// { indexPhase, opType, opStep, playing, opDone, zoomShard }.
export const TOUR_STEPS = [
  {
    id: 'welcome',
    target: null,
    title: 'Welcome to the OpenSearch Cluster Visualizer',
    body: [
      'This app shows how OpenSearch (and Lucene under the hood) indexes documents and searches them across a distributed cluster — all simulated right here in your browser.',
      'One tip before you start: wherever you see the 🔍 magnifying glass, you can click it to zoom into a much more granular view of what a shard is doing.',
      'Take the one-minute tour? You will index your first document and run your first search.',
    ],
    cta: 'Start the tour',
    secondary: 'Skip for now',
  },
  {
    id: 'open-index',
    target: '[data-tour="index-doc"]',
    placement: 'right',
    title: 'Index your first document',
    body: 'Everything starts with a document. Click “＋ Index a document” to open the editor.',
    advanceOn: (s) => s.indexPhase === 'editing',
  },
  {
    id: 'index-form',
    target: '[data-tour="index-card"]',
    placement: 'right',
    title: 'Write (or pick) a document',
    body: 'Grab a preset or write your own title and body, then click “Index document”. Watch it route to the coordinator, hash to a shard, get analyzed into terms, and replicate to a second node.',
    waitFor: (s) => s.indexPhase === 'editing',
    advanceOn: (s) => s.opType === 'index',
  },
  {
    id: 'refresh',
    target: '[data-tour="refresh"]',
    placement: 'right',
    title: 'Not searchable… yet',
    body: 'Your document landed in the shard’s in-memory buffer, which searches never see. OpenSearch is near-real-time: click “Refresh” to build an immutable segment and make the doc searchable.',
    waitFor: (s) => s.indexPhase === 'done' && !s.playing,
    advanceOn: (s) => s.opType === 'refresh',
  },
  {
    id: 'search',
    target: '[data-tour="search-area"]',
    placement: 'right',
    title: 'Now search for it',
    body: 'Keep the suggested query, pick a chip, or type your own words — then hit “Search” to watch the coordinator scatter the query to every shard and gather a ranked response.',
    waitFor: (s) => s.opType === 'refresh' && s.opDone && !s.playing,
    advanceOn: (s) => s.opType === 'search',
  },
  {
    id: 'magnify',
    target: '[data-tour="magnify"]',
    placement: 'bottom',
    title: 'Zoom into a shard',
    // Pausing here cancels the auto-play clock so the transient 🔍 button stays
    // mounted while the user reads. The advanceOn escape hatch covers a user who
    // presses ▶ Play instead of clicking the magnifier.
    waitFor: (s) => s.opType === 'search' && s.opStep === 2,
    onShow: (s, actions) => actions.pause(),
    body: 'The search is paused mid-flight: each serving shard is running its own local search right now. Click the highlighted 🔍 — that shard holds your document — for a granular, step-by-step view inside it.',
    advanceOn: (s) => s.zoomShard != null || (s.opDone && !s.playing),
  },
  {
    id: 'stepper',
    target: '[data-tour="stepper"]',
    placement: 'top',
    title: 'Scrub the timeline',
    body: 'Every operation is a step-by-step timeline. Use ‹ Prev and Next › in the footer to move through the paused search at your own pace, or press ▶ Play to let it run — try it now if you like.',
    // Hidden while the shard inspector is open so it never covers the close-up.
    // Purely manual: the stepper stays usable inside the spotlight hole, and
    // "Got it" moves on whenever the user is ready.
    waitFor: (s) => s.zoomShard == null,
    cta: 'Got it',
  },
  {
    id: 'finish',
    target: null,
    title: 'That’s the loop!',
    body: [
      'You indexed a document, made it searchable with a refresh, and ran a scatter-gather search — and you can replay any operation from the footer.',
      'Remember: the 🔍 appears whenever a shard is serving a search — click it any time for the granular view. Try Flush, Merge, and deleting documents next.',
    ],
    waitFor: (s) => s.zoomShard == null,
    cta: 'Done',
  },
]
