// "Why do my scores depend on which shard a document landed on?"
//
// Runs the SAME query twice against the SAME data, changing only the search
// type — and the client gets a different ranking back. That is the whole
// scenario, and it works because of a property of the default dataset that
// scripts/check-models.mjs section 10 pins: under both search types every shard
// returns the same documents in the same order, so nothing else can be blamed
// for the change. The third result changes hands, and the document that held it
// drops out of the window.
//
// The numbers are never written into copy — the coordinator's own idf strip and
// the response dialog are where the reader reads them. What the copy does is
// say WHERE to look, because the change is at #3 rather than #1 and would
// otherwise be easy to miss.
//
// No reviewResults step: the two response beats ARE the payoff here, so each
// gets its own copy pointing at the row that changes rather than the shared
// "here is the JSON" tip.

const STEPS = [
  {
    id: 'welcome',
    target: null,
    title: 'Why is relevance shard-local?',
    body: [
      'A shard scores with the statistics it can see: how rare a word is, measured against its OWN documents. Nobody reconciles that across shards.',
      'So a word can look rare on one shard and ordinary on another, and the coordinator then sorts those scores against each other as if they meant the same thing. Let us make it change an answer.',
    ],
    cta: 'Show me',
    secondary: 'Skip for now',
  },
  {
    id: 'load',
    target: '[data-tour="load-docs"]',
    targetExtra: '[data-tour="load-docs-menu"]',
    dataset: 'sample',
    placement: 'right',
    title: 'Load the sample documents',
    body: 'Open “Load docs” and pick “Sample docs”. Thirty-two documents about search, spread across three shards by _id — which is what makes the shards disagree.',
    advanceOn: (s) => s.sampleSet === 'sample',
  },
  {
    id: 'run-plain',
    target: '[data-tour="search-area"]',
    placement: 'right',
    title: 'Search the ordinary way',
    body: 'The query is “search”. Hit Search — this is query_then_fetch, Elasticsearch’s default, where every shard scores alone.',
    onShow: (s, actions) => {
      actions.setQuery('search')
      actions.setRouting('')
    },
    advanceOn: (s) => s.opType === 'search' && s.opQuery === 'search' && !s.opDfs,
  },
  {
    id: 'coord-zoom',
    target: '[data-tour="coord-magnify"]',
    placement: 'bottom',
    title: 'Look at what the coordinator is holding',
    waitFor: (s) => s.opPhase === 'gather' && !s.opDfs && s.closeUpDepth === 0,
    onShow: (s, actions) => actions.pause(),
    body: 'Every shard has reported its top hits. Click the 🔍 on the coordinator — the ranking it is about to produce is the thing this scenario is about.',
    advanceOn: (s) => s.coordZoom || (s.opDone && !s.playing),
  },
  {
    id: 'the-disagreement',
    target: '[data-tour="cu-stepper"]',
    placement: 'left',
    noDim: true,
    title: 'The same word, three different weights',
    waitFor: (s) => s.closeUpKind === 'coordinator' && s.closeUpStep >= 2,
    body: 'Under the ranking, the shards’ own figures for “search”. One of them holds fewer documents and fewer of them contain the word, so it rates the word rarer than the others do — and scores its hits higher for it. Note which document is sitting third, and which shard it came from.',
    cta: 'Noted',
  },
  {
    id: 'resume-plain',
    target: '[data-tour="stepper-play"]',
    placement: 'top',
    title: 'Let it finish',
    waitFor: (s) => s.closeUpDepth === 0,
    body: 'Close the panel and press ▶ Play to let the search return.',
    highlightPlay: true,
    advanceOn: (s) => s.opDone && !s.playing,
  },
  {
    id: 'before',
    target: '[data-tour="result-3"]',
    placement: 'right',
    // noDim, not a dimmed spotlight: the step rings the row it wants read AND
    // asks for the response to be closed, and a dimmed hole around one row
    // swallows the click on the dialog's ✕. Nothing is blocked here, and the
    // advanceOn is exactly "the reader closed it", so the step cannot strand.
    noDim: true,
    title: 'Third place, before',
    waitFor: (s) => s.resultsOpen && !s.opDfs,
    body: 'This is the answer the client gets. Hold on to the third row — the document, its shard, and its score. Close the response when you have it.',
    advanceOn: (s) => !s.resultsOpen,
  },
  {
    id: 'turn-on-dfs',
    target: '[data-tour="dfs-toggle"]',
    placement: 'right',
    title: 'Now ask the shards to agree first',
    onShow: (s, actions) => actions.openAdvanced(),
    body: 'Tick dfs_query_then_fetch. It adds a round trip: the coordinator collects every shard’s document frequencies, sums them, and sends the totals out with the query.',
    advanceOn: (s) => s.dfsOn,
  },
  {
    id: 'run-dfs',
    target: '[data-tour="search-area"]',
    placement: 'right',
    title: 'Run exactly the same query',
    waitFor: (s) => s.dfsOn,
    body: 'Same query, same documents, same shards. Only the search type is different. Hit Search.',
    advanceOn: (s) => s.opType === 'search' && s.opDfs,
  },
  {
    id: 'the-round-trip',
    target: '[data-tour="cluster"]',
    placement: 'left',
    noDim: true,
    title: 'This is what it costs',
    waitFor: (s) => s.opDfs && s.opPhase === 'dfs',
    onShow: (s, actions) => actions.pause(),
    body: 'The coordinator has the query, and before asking anyone to search it asks everyone what the terms are worth. A whole extra round trip, carrying numbers rather than documents — that is why this is not the default.',
    cta: 'Got it',
  },
  {
    id: 'stats-zoom',
    target: '[data-tour="stats-magnify"]',
    placement: 'left',
    title: 'What is a shard actually doing here?',
    waitFor: (s) => s.opDfs && s.opPhase === 'dfs' && s.closeUpDepth === 0,
    body: 'It sounds like it has to search for the term to count what it is in. Open a shard’s 🔍 and see.',
    advanceOn: (s) => s.closeUpKind === 'stats',
  },
  {
    id: 'stats-dive',
    target: '[data-anat-stats]',
    placement: 'left',
    title: 'Go one level further',
    // The panel's own second step is where the segment 🔍 appears.
    waitFor: (s) => s.closeUpKind === 'stats' && s.closeUpStep >= 1,
    body: 'Each segment is being looked up. Press into one to watch how far that lookup actually goes.',
    advanceOn: (s) => s.closeUpKind === 'segment' || s.closeUpDepth === 0,
  },
  {
    id: 'stops-early',
    // Rings the HEAD of the tile that was not opened. The tile's own box is
    // taller than the panel's scroller, so ringing the whole thing draws a line
    // off the bottom of the screen; its head is short, always in view, and says
    // which tile this is. (tipPos also clamps `top` to vh - 220, so a long tip
    // anchored low puts its own button off-screen — keep this body short.)
    target: '[data-seg-tile="doc"] .seg-tile-head',
    placement: 'left',
    // noDim: the point is a comparison across the whole panel — two lit tiles
    // above, two dark ones below — and dimming three quarters of it would hide
    // exactly the half that carries the lesson.
    noDim: true,
    title: 'It stops at the term row',
    waitFor: (s) => s.closeUpKind === 'segment' && s.closeUpStep >= 4,
    body: 'The postings were never opened — the count was in the term row above, beside a pointer nobody followed. The query phase will seek this same term again, so the lookup is paid twice and the posting list is walked once.',
    cta: 'Got it',
  },
  {
    id: 'resume-dfs',
    target: '[data-tour="stepper-play"]',
    placement: 'top',
    title: 'Let it finish',
    waitFor: (s) => s.closeUpDepth === 0,
    body: 'Press ▶ Play. Every shard will do exactly the work it did last time — same candidates, same posting lists, same top hits.',
    highlightPlay: true,
    advanceOn: (s) => s.opDone && !s.playing,
  },
  {
    id: 'after',
    target: '[data-tour="result-3"]',
    placement: 'right',
    noDim: true, // same reason as `before`
    title: 'Third place, after',
    waitFor: (s) => s.resultsOpen && s.opDfs,
    body: 'Third place has changed hands, and the document that held it is no longer in the results at all. No shard searched differently — the shard that was overrating the word simply stopped. Close the response.',
    advanceOn: (s) => !s.resultsOpen,
  },
  {
    id: 'finish',
    target: null,
    title: 'What you just saw',
    body: [
      'query_then_fetch scores with what each shard can see on its own. It is one round trip, and on a real index — where every shard holds a large, similar sample — the shards mostly agree and the ranking is fine.',
      'They agree less the smaller and more skewed the shards are, which is when dfs_query_then_fetch earns its extra round trip. Reach for it when scores look wrong near the cut, not by default.',
    ],
    cta: 'Done',
  },
]

export default {
  id: 'dfs',
  label: 'query_then_fetch vs dfs_query_then_fetch',
  blurb: 'Run one query two ways and watch the results come back in a different order.',
  steps: STEPS,
}
