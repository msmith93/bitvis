// The first-run guided tour, and the default scenario. Each step spotlights a
// real control and advances when the user actually uses it (`advanceOn`), not
// via a Next button — only the centered welcome/finish cards (target: null)
// advance manually. `waitFor` gates VISIBILITY only: while false the scenario
// renders nothing, which is how it waits out op animations and lets the app's
// own "What's happening" panel narrate.
//
// Predicates read the snapshot App builds — see src/scenarios/index.js for the
// full shape.
const STEPS = [
  {
    id: 'welcome',
    target: null,
    title: 'Welcome to the Elasticsearch Cluster Visualizer',
    body: [
      'This app shows how Elasticsearch (and Lucene under the hood) indexes documents and searches them across a distributed cluster — all simulated right here in your browser.',
      'One tip before you start: wherever you see the 🔍 magnifying glass, you can click it to zoom into a much more granular view of what a shard — or the coordinator — is doing.',
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
    body: 'Your document landed in the shard’s in-memory buffer, which searches never see. Elasticsearch is near-real-time: click “Refresh” to build an immutable segment and make the doc searchable.',
    waitFor: (s) => s.indexPhase === 'done' && !s.playing,
    advanceOn: (s) => s.opType === 'refresh',
  },
  {
    id: 'load-sample',
    target: '[data-tour="load-sample"]',
    placement: 'right',
    title: 'Load a richer dataset',
    body: 'A single document makes for a lonely search. Click “Load sample docs” to seed a realistic cluster — about a dozen documents routed and replicated across all three shards — so the search you run next has something interesting to rank.',
    waitFor: (s) => s.opType === 'refresh' && s.opDone && !s.playing,
    // Either dataset satisfies "now there is something to search".
    advanceOn: (s) => s.sampleSet != null,
  },
  {
    id: 'search',
    target: '[data-tour="search-area"]',
    placement: 'right',
    title: 'Now search across them',
    body: 'Keep the suggested query, pick a chip, or type your own words — then hit “Search” to watch the coordinator scatter the query to every shard and gather a ranked response.',
    waitFor: (s) => s.sampleSet != null && !s.playing,
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
    body: 'The search is paused mid-flight: each serving shard is running its own local search right now. Click the highlighted 🔍 — that shard holds several of the matching documents — for a granular, step-by-step view inside it.',
    advanceOn: (s) => s.zoomShard != null || (s.opDone && !s.playing),
  },
  {
    id: 'stepper',
    target: '[data-tour="stepper-play"]',
    placement: 'top',
    title: 'Resume the search',
    body: 'The search is still paused mid-flight. Press ▶ Play right here to resume it — watch every shard’s hits (ids + scores, not documents) fly back to the coordinator.',
    // Spotlights the footer ▶ Play button directly so the tooltip sits right next
    // to it. Hidden while the shard inspector is open so it never covers the
    // close-up. The opStep escape hatch covers a user who scrubs forward with
    // Next instead of pressing Play.
    waitFor: (s) => s.zoomShard == null,
    highlightPlay: true,
    advanceOn: (s) => s.playing || (s.opType === 'search' && s.opStep >= 3),
  },
  {
    id: 'coord-magnify',
    target: '[data-tour="coord-magnify"]',
    placement: 'bottom',
    title: 'Zoom into the coordinator',
    // Same pattern as the shard magnifier: pause so the transient 🔍 stays
    // mounted while the user reads; the advanceOn escape hatch covers a user
    // who presses ▶ Play instead of clicking it.
    waitFor: (s) => s.opType === 'search' && s.opStep === 3 && s.zoomShard == null,
    onShow: (s, actions) => actions.pause(),
    body: 'Every shard has now reported its top hits — ids and scores only. Click the 🔍 on the coordinator to watch it merge the lists, rank them globally, and decide which full documents to fetch from which shards.',
    advanceOn: (s) => s.coordZoom || (s.opDone && !s.playing),
  },
  {
    id: 'stepper-finish',
    target: '[data-tour="stepper-play"]',
    placement: 'top',
    title: 'Run the search to the end',
    body: 'Press ▶ Play once more to let the search run to the end — watch the coordinator fetch the winning documents from their shards and return the ranked results.',
    // Hidden while either inspector is open. Advances only once the search
    // animation reaches its final step, so the tour can't end with the
    // scatter-gather still frozen. "Skip" in the tooltip is the escape
    // hatch for anyone who wants out early.
    waitFor: (s) => s.zoomShard == null && !s.coordZoom,
    advanceOn: (s) => s.opType === 'search' && s.opDone && !s.playing,
  },
  {
    id: 'finish',
    target: null,
    title: 'That’s the loop!',
    body: [
      'You indexed a document, made it searchable with a refresh, loaded a fuller sample dataset, and ran a scatter-gather search to completion — and you can replay any operation from the footer.',
      'Remember the two 🔍 magnifiers: one on each serving shard during the local search, and one on the coordinator while it gathers and fetches — click either any time for the granular view. Try Flush, Merge, and deleting documents next.',
      'One last thing to show you: this tour is not the only lesson here.',
    ],
    // Belt-and-suspenders: never surface the end card until the search animation
    // has fully completed (and both inspectors are closed).
    waitFor: (s) =>
      s.zoomShard == null && !s.coordZoom && s.opType === 'search' && s.opDone,
    cta: 'Show me',
  },
  {
    id: 'scenarios',
    target: '[data-tour="scenarios"]',
    placement: 'left',
    title: 'More lessons live here',
    body: 'Open the Scenarios menu to see the rest — why a leading wildcard is expensive, what a routing key really does, and what a term dictionary looks like on disk. Click it to take a look; you do not have to start one.',
    // The tour ends the moment the menu opens: the point is that the user
    // discovers the menu exists, not that they commit to a particular lesson.
    // Anything they pick from the open menu starts that scenario as usual.
    waitFor: (s) => s.closeUpDepth === 0,
    advanceOn: (s) => s.scenariosOpen,
  },
]

export default {
  id: 'intro',
  label: 'Guided intro tour',
  blurb: 'Index a document, refresh it, and run your first scatter-gather search.',
  steps: STEPS,
  setup: (actions) => actions.reset(),
}
