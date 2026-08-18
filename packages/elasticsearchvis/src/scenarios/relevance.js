// "Why does the same query rank differently?"
//
// Runs the SAME query twice against the SAME data — once as query_then_fetch,
// once as dfs_query_then_fetch — so the only thing that changes is whose
// document counts BM25 was given. The ranking changes anyway, which is the point.
//
// Every number the copy relies on is real and checked against the sample docs:
// shard 1 holds 4 documents to shard 0's 5, which inflates its idf enough that
// doc-3 (tf=2) outranks doc-2 (tf=4). Under global statistics doc-2 takes #1 and
// doc-3 falls to #5.
const STEPS = [
  {
    id: 'welcome',
    target: null,
    title: 'Why does the same query rank differently?',
    body: [
      'A BM25 score is not a property of a document. It is a comparison against a collection — how rare is this term, how long is this document against the average.',
      'But in a distributed index there is no single collection. Each shard holds a different handful of documents, and by default each one scores using only what IT can see.',
      'You will run one query twice, changing nothing but that, and watch the top result change hands.',
    ],
    cta: 'Show me',
    secondary: 'Skip for now',
  },
  {
    id: 'load',
    target: '[data-tour="load-sample"]',
    placement: 'right',
    title: 'Load the sample documents',
    body: 'Click “Load sample docs”. Fourteen documents, spread over three shards by hash(_id) — which means the shards end up holding uneven numbers of them. That unevenness is the whole story.',
    advanceOn: (s) => s.sampleSet === 'sample',
  },
  {
    id: 'run-local',
    target: '[data-tour="search-area"]',
    placement: 'right',
    title: 'Search the ordinary way',
    body: 'We have filled in “search” and set the search type to query_then_fetch — the default. Hit Search and let it run to the end.',
    waitFor: (s) => !s.playing,
    onShow: (s, actions) => {
      actions.setQuery('search')
      actions.setRouting('')
      actions.setSearchType('query_then_fetch')
    },
    advanceOn: (s) => s.opSearchType === 'query_then_fetch' && s.opQuery === 'search',
  },
  {
    id: 'watch-local',
    target: '[data-tour="cluster"]',
    placement: 'left',
    title: 'Look at what each shard was scoring against',
    waitFor: (s) => s.opSearchType === 'query_then_fetch' && s.opStepsDone.includes('local'),
    onShow: (s, actions) => actions.pause(),
    body: 'Check the line under each shard in the results panel. Shard 0 scored against its own 5 documents, shard 1 against 4, shard 2 against 5. Three different collections, three different ideas of how rare the word “search” is — and every score you are about to compare came out of a different one.',
    cta: 'Got it',
  },
  {
    id: 'resume-local',
    target: '[data-tour="stepper-play"]',
    placement: 'top',
    title: 'Let it finish',
    body: 'Press ▶ Play to run the search out to the ranked response.',
    waitFor: (s) => s.closeUpDepth === 0,
    highlightPlay: true,
    advanceOn: (s) => s.opType === 'search' && s.opDone && !s.playing,
  },
  {
    id: 'read-local',
    target: '[data-tour="cluster"]',
    placement: 'left',
    title: 'doc-3 won',
    waitFor: (s) => s.closeUpDepth === 0,
    body: 'Read the ranking. doc-3 is first — and it contains “search” twice. doc-2, sitting second, contains it four times and is a shorter document. On any sane reading doc-2 should have won. It lost because it lives on a shard holding 5 documents while doc-3 lives on one holding 4, which made the word look rarer over there.',
    cta: 'That seems wrong',
  },
  // Two steps rather than one, because this asks for two actions: flip the
  // control, then run it. Spotlighting the toggle and then the search area keeps
  // the ring on whatever the user is actually being asked to click next.
  {
    id: 'switch-dfs',
    target: '[data-tour="search-type"]',
    placement: 'right',
    title: 'Switch to dfs_query_then_fetch',
    body: 'Click dfs_query_then_fetch. Nothing happens yet — this only changes what the NEXT search does.',
    waitFor: (s) => s.closeUpDepth === 0 && !s.playing,
    advanceOn: (s) => s.searchType === 'dfs_query_then_fetch',
  },
  {
    id: 'run-dfs',
    target: '[data-tour="search-area"]',
    placement: 'right',
    title: 'Run the very same query again',
    body: 'Hit Search. Same query, same documents, same everything — except the coordinator will now ask every shard for its statistics before searching, and hand the totals back out.',
    waitFor: (s) => s.closeUpDepth === 0 && !s.playing,
    advanceOn: (s) => s.opSearchType === 'dfs_query_then_fetch',
  },
  {
    id: 'watch-dfs',
    target: '[data-tour="cluster"]',
    placement: 'left',
    title: 'The extra round trip',
    waitFor: (s) => s.opSearchType === 'dfs_query_then_fetch' && s.opStepsDone.includes('dfs'),
    onShow: (s, actions) => actions.pause(),
    body: 'This is the step that did not exist a moment ago. Every shard reports how many documents it holds and how many contain each query term; the coordinator adds them up and sends the totals back out with the query. That is a whole extra round trip before any searching happens, which is exactly why this is not the default.',
    cta: 'Got it',
  },
  {
    id: 'resume-dfs',
    target: '[data-tour="stepper-play"]',
    placement: 'top',
    title: 'Now let it search',
    body: 'Press ▶ Play. Watch the per-shard lines again — all three now say they are scoring against the whole index.',
    waitFor: (s) => s.closeUpDepth === 0,
    highlightPlay: true,
    advanceOn: (s) => s.opType === 'search' && s.opDone && !s.playing,
  },
  {
    id: 'read-dfs',
    target: '[data-tour="cluster"]',
    placement: 'left',
    title: 'doc-2 takes it back',
    waitFor: (s) => s.closeUpDepth === 0,
    body: 'doc-2 is first now and doc-3 has fallen to fifth. Nothing about either document changed — not a word of their text, not which shard they are on. Only the numbers they were measured against. That is the whole of what DFS buys.',
    cta: 'Show me the arithmetic',
  },
  {
    id: 'finish',
    target: null,
    title: 'When this matters',
    body: [
      'The skew shrinks as shards fill up: with millions of documents each, per-shard frequencies converge on the global ones and the two search types agree. It bites hardest exactly where you are most likely to meet it — small indices, test data, and anything unevenly routed.',
      'The price is a full extra round trip on every query, so DFS is a deliberate choice, not a default. If your relevance looks wrong on a small index, try it before you start rewriting the query.',
      'Want to see the sum itself? Run a search, open a shard’s 🔍 at the local-search step, walk to “Score each candidate” and click the 🔍 on any score — it shows every factor, and what that document would have scored under the other collection.',
    ],
    waitFor: (s) => s.closeUpDepth === 0,
    cta: 'Done',
  },
]

export default {
  id: 'relevance',
  label: 'Why the same query ranks differently',
  blurb:
    'BM25 scores against a collection — and each shard has its own. The same query, ranked twice.',
  steps: STEPS,
  setup: (actions) => {
    actions.reset()
    actions.setSearchType('query_then_fetch')
  },
}
