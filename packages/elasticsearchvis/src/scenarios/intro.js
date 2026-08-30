// The first-run guided tour, and the default scenario. Each step spotlights a
// real control and advances when the user actually uses it (`advanceOn`), not
// via a Next button — only the centered welcome/finish cards (target: null)
// advance manually. `waitFor` gates VISIBILITY only: while false the scenario
// renders nothing, which is how it waits out op animations and lets the app's
// own "What's happening" panel narrate.
//
// Predicates read the snapshot App builds — see src/scenarios/index.js for the
// full shape.
import { reviewResults } from './shared'

const STEPS = [
  {
    id: 'welcome',
    target: null,
    title: 'Welcome to the Elasticsearch Cluster Visualizer',
    body: [
      'This app shows how Elasticsearch (and Lucene under the hood) indexes documents and searches them across a distributed cluster.',
      'Wherever you see the 🔍 magnifying glass, you can click it to zoom in for more detail.',
      'Take the one-minute tour and index a document and run a search.',
    ],
    cta: 'Start the tour',
    secondary: 'Skip for now',
  },
  {
    id: 'open-index',
    target: '[data-tour="index-doc"]',
    placement: 'right',
    title: 'Index a document',
    body: 'Everything starts with a document. Click to open the editor.',
    advanceOn: (s) => s.indexPhase === 'editing',
  },
  {
    id: 'index-form',
    target: '[data-tour="index-card"]',
    placement: 'right',
    title: 'Write (or pick) a document',
    body: 'Grab a preset or write your own title and body, then click “Index document”.',
    waitFor: (s) => s.indexPhase === 'editing',
    advanceOn: (s) => s.opType === 'index',
  },
  {
    id: 'refresh',
    target: '[data-tour="refresh"]',
    placement: 'right',
    title: 'Not searchable… yet',
    body: 'Your document landed in the shard’s in-memory buffer, which searches never see. Elasticsearch is near-real-time: click “Refresh” to build an immutable segment and make the doc searchable. ' +
            'Normally this operation would run automatically every ~1s on the cluster.',
    waitFor: (s) => s.indexPhase === 'done' && !s.playing,
    advanceOn: (s) => s.opType === 'refresh',
  },
  {
    id: 'load-sample',
    target: '[data-tour="load-docs"]',
    targetExtra: '[data-tour="load-docs-menu"]',
    dataset: 'sample',
    placement: 'right',
    title: 'Load a richer dataset',
    body: 'A single document makes for a lonely search. Open “Load docs” and pick “Sample docs” to seed more data.',
    waitFor: (s) => s.opType === 'refresh' && s.opDone && !s.playing,
    // `dataset` above is what the menu offers here, but either set satisfies
    // "now there is something to search" — so a load that happened earlier,
    // before this step was showing, still advances it rather than stranding it.
    advanceOn: (s) => s.sampleSet != null,
  },
  {
    id: 'search',
    target: '[data-tour="search-area"]',
    placement: 'right',
    title: 'Now search across them',
    body: 'Keep the suggested query, pick a chip, or type your own words. Then hit “Search” to watch the coordinator scatter the query to every shard and gather a ranked response.',
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
    body: 'Click the highlighted 🔍 to zoom into one of the shards the search is running on.',
    advanceOn: (s) => s.zoomShard != null || (s.opDone && !s.playing),
  },
  {
    id: 'stepper',
    target: '[data-tour="stepper-play"]',
    placement: 'top',
    title: 'Resume the search',
    body: 'The search is still paused mid-flight. Press ▶ Play to resume it.',
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
    body: 'Every shard has now reported its top hits — ids and scores only. Click the 🔍 to zoom in to the coordinator.',
    advanceOn: (s) => s.coordZoom || (s.opDone && !s.playing),
  },
  {
    id: 'stepper-finish',
    target: '[data-tour="stepper-play"]',
    placement: 'top',
    title: 'Resume the search',
    body: 'The search is still paused mid-flight. Press ▶ Play to resume it.',
    // Hidden while either inspector is open. Advances only once the search
    // animation reaches its final step, so the tour can't end with the
    // scatter-gather still frozen. "Skip" in the tooltip is the escape
    // hatch for anyone who wants out early.
    waitFor: (s) => s.zoomShard == null && !s.coordZoom,
    advanceOn: (s) => s.opType === 'search' && s.opDone && !s.playing,
  },
  reviewResults('review-results'),
  {
    id: 'finish',
    target: null,
    title: 'That’s the loop!',
    body: [
      'You indexed a document, made it searchable with a refresh, loaded a fuller sample dataset, and ran a scatter-gather search to completion — and you can replay any operation from the footer.',
      'Remember you can click the 🔍 icon for a more detialed view at many places in these scenarios.',
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
    body: 'Open the Scenarios menu to see more detailed lessons about ElasticSearch.',
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
