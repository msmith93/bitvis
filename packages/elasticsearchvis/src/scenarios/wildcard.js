// "Why are prefix wildcard queries expensive?"
//
// The lesson is one property of the term dictionary — it is SORTED — and the two
// very different things that follow from it. The scenario runs the same query
// shape twice, `sc*` then `*search`, and sends the user into the 🔍 close-up
// both times, because the difference is only visible inside a segment: a seek
// that touches a handful of rows versus an enumeration of every single one.
const STEPS = [
  {
    id: 'welcome',
    target: null,
    title: 'Why are leading wildcards expensive?',
    body: [
      'A shard’s inverted index keeps its terms in sorted order. That one detail decides whether a wildcard query is cheap or ruinous.',
      '“sc*” has a literal prefix to jump to. “*search” does not — and you will watch the difference, term by term, inside a real segment.',
      'A naming note, because both conventions are common: Elasticsearch calls “search*” a PREFIX QUERY (the wildcard is at the end). “*search” is the LEADING WILDCARD. It is the leading one that hurts.',
    ],
    cta: 'Show me',
    secondary: 'Skip for now',
  },
  {
    id: 'load',
    target: '[data-tour="load-sample"]',
    placement: 'right',
    title: 'Start with some data',
    body: 'Click “Load sample docs” to fill the cluster with searchable segments — we need a term dictionary with something in it.',
    advanceOn: (s) => s.sampleSet === 'sample',
  },
  {
    id: 'merge',
    target: '[data-tour="merge"]',
    placement: 'right',
    title: 'Merge first, so the dictionaries are worth reading',
    body: 'Click Merge. Each shard’s small segments become one bigger segment — 24 to 43 terms each instead of a dozen. The cost difference you are about to see is only interesting against a dictionary with something in it.',
    // Merge is disabled while another op's clock runs, and the sample set
    // tombstones a doc so Refresh is live too — an off-script click lands here.
    // Wait for an idle timeline so the ring only lands on a pressable button.
    waitFor: (s) => !s.playing,
    advanceOn: (s) => s.opType === 'merge',
  },
  {
    id: 'run-prefix',
    target: '[data-tour="search-area"]',
    placement: 'right',
    title: 'First, the cheap one: sc*',
    body: 'We have put “sc*” in the search box — every term starting with “sc”. Hit Search.',
    // Search is disabled until the merge has both finished and stopped playing.
    waitFor: (s) => (s.opType !== 'merge' || s.opDone) && !s.playing,
    onShow: (s, actions) => {
      actions.setRouting('')
      actions.setQuery('sc*')
    },
    advanceOn: (s) => s.opQuery === 'sc*',
  },
  {
    id: 'magnify-prefix',
    target: '[data-tour="magnify"]',
    placement: 'bottom',
    title: 'Look inside a segment',
    waitFor: (s) => s.opQuery === 'sc*' && s.opStepKey === 'local',
    onShow: (s, actions) => actions.pause(),
    body: 'Every serving shard is now resolving that pattern in each of its segments. Click the highlighted 🔍 and watch the dictionary get seeked: the probe bounces to narrow down where “sc” belongs, then reads forward only while the prefix holds.',
    advanceOn: (s) => s.zoomShard != null || (s.opDone && !s.playing),
  },
  {
    id: 'resume-prefix',
    target: '[data-tour="stepper-play"]',
    placement: 'top',
    title: 'Let that search finish',
    body: 'Press ▶ Play to let the paused search run to the end, so the Search button is free for the second query.',
    // Hidden while either close-up is open so it can never cover one.
    waitFor: (s) => s.zoomShard == null && !s.coordZoom,
    highlightPlay: true,
    advanceOn: (s) => s.opType === 'search' && s.opDone && !s.playing,
  },
  {
    id: 'run-leading',
    target: '[data-tour="search-area"]',
    placement: 'right',
    title: 'Now the expensive one: *search',
    body: 'Same shape, wildcard on the other end. “*search” matches “search” AND “elasticsearch” — two terms sitting in completely different parts of the sorted dictionary. Hit Search.',
    waitFor: (s) => s.zoomShard == null && !s.coordZoom,
    onShow: (s, actions) => actions.setQuery('*search'),
    advanceOn: (s) => s.opQuery === '*search',
  },
  {
    id: 'magnify-leading',
    target: '[data-tour="magnify"]',
    placement: 'bottom',
    title: 'Nothing to seek to',
    waitFor: (s) => s.opQuery === '*search' && s.opStepKey === 'local',
    onShow: (s, actions) => actions.pause(),
    body: 'Click 🔍 again. There is no prefix to jump to, so the segment reads every term in order and tests each one — and the two matches really are far apart. Watch the “examined” counter: it ends at 100%.',
    advanceOn: (s) => s.zoomShard != null || (s.opDone && !s.playing),
  },
  {
    id: 'resume-leading',
    target: '[data-tour="stepper-play"]',
    placement: 'top',
    title: 'Run it to the end',
    body: 'Press ▶ Play once more to finish the search — the wildcard is an ordinary boolean OR from here, so the rest of the flow is exactly the scatter-gather you already know.',
    waitFor: (s) => s.zoomShard == null && !s.coordZoom,
    highlightPlay: true,
    advanceOn: (s) => s.opType === 'search' && s.opDone && !s.playing,
  },
  {
    id: 'finish',
    target: null,
    title: 'That is the whole story',
    body: [
      'A prefix like “sc*” costs a seek plus the matching range. A leading wildcard costs the ENTIRE term dictionary — and that price is paid per segment, per shard, on every node the query touches. The line under “What’s happening” totals it up for the query you just ran.',
      'It is also why the usual fix is to index the data differently rather than query harder: a reverse field, an ngram/wildcard field, or a prefix you can actually seek to.',
      'This view models the seek as a binary search over a flat sorted array. Real Lucene walks an FST + block-tree, and it compiles the pattern into an automaton rather than testing a regex — both of which you can watch one zoom deeper, via the 🔍 on the “term dictionary” column head (or the “What an inverted index really looks like” scenario).',
    ],
    waitFor: (s) => s.zoomShard == null && !s.coordZoom,
    cta: 'Done',
  },
]

export default {
  id: 'wildcard',
  label: 'Why leading wildcards are expensive',
  blurb: 'Watch a segment seek “sc*” — then read every term for “*search”.',
  steps: STEPS,
  setup: (actions) => actions.reset(),
}
