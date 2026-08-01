// "How does a typo still find the document?"
//
// Three things worth knowing about fuzzy, in the order they bite:
//   1. it works — `serch~` finds "search"
//   2. it is priced like a leading wildcard, and prefix_length is the fix
//   3. it matches by SPELLING, so it finds words you never meant
//
// The middle one reuses the wildcard scenario's shape (same query, one knob) and
// the numbers come from the traces: on the merged shard-0 segment `serch~1` reads
// 24 of 24 terms at prefix_length 0 and 5 of 24 at 2.
const STEPS = [
  {
    id: 'welcome',
    target: null,
    title: 'How does a typo still find the document?',
    body: [
      'Type “serch” and an exact term lookup finds nothing at all — the dictionary is sorted, the word simply is not in it, and being one letter away counts for nothing.',
      'A fuzzy query asks a different question: not “where is this term” but “which terms are within N edits of it”. That turns out to be answerable with the same machinery a wildcard uses, and to cost about the same as the worst kind of wildcard.',
      'You will watch it find the typo, see what it costs, fix the cost, and then see what it costs you in a different currency.',
    ],
    cta: 'Show me',
    secondary: 'Skip for now',
  },
  {
    id: 'load',
    target: '[data-tour="load-sample"]',
    placement: 'right',
    title: 'Load the sample documents',
    body: 'Click “Load sample docs”.',
    advanceOn: (s) => s.sampleSet === 'sample',
  },
  {
    id: 'merge',
    target: '[data-tour="merge"]',
    placement: 'right',
    title: 'Merge to one segment per shard',
    body: 'Click Merge. Each shard collapses to a single segment, which gives every shard one term dictionary instead of three — easier to watch a walk through.',
    waitFor: (s) => !s.playing,
    advanceOn: (s) => s.opType === 'merge',
  },
  {
    id: 'run',
    target: '[data-tour="search-area"]',
    placement: 'right',
    title: 'Search for a word that isn’t there',
    body: 'We have filled in “serch~”. The bare ~ means Fuzziness.AUTO, and at five characters that is one edit. Hit Search.',
    waitFor: (s) => (s.opType !== 'merge' || s.opDone) && !s.playing,
    onShow: (s, actions) => {
      actions.setRouting('')
      actions.setFuzzyPrefix(0)
      actions.setQuery('serch~')
    },
    advanceOn: (s) => s.opQuery === 'serch~',
  },
  {
    id: 'magnify',
    target: '[data-tour="magnify"]',
    placement: 'bottom',
    title: 'Watch it read the whole dictionary',
    waitFor: (s) => s.opQuery === 'serch~' && s.opStepKey === 'local',
    onShow: (s, actions) => actions.pause(),
    body: 'Click the 🔍 on shard 0 and watch the dictionary step replay. Every term gets read — not most, every one. With prefix_length 0 the first character is allowed to be the wrong one, so a match could be anywhere and there is nothing to seek to. A fuzzy query costs what “*search” costs.',
    advanceOn: (s) => s.closeUpKind === 'shard' || (s.opDone && !s.playing),
  },
  {
    id: 'dictionary',
    target: '[data-anat-dict]',
    placement: 'bottom',
    title: 'And why, structurally',
    waitFor: (s) => s.closeUpKind === 'shard',
    body: 'Go one level deeper: click the 🔍 on a segment’s term-dictionary column. The edit distance has been compiled into a machine, and it is walked against the index arc by arc. With nothing pinned at the front it can spend an edit immediately, so no arc can be rejected and every block leaves the disk.',
    advanceOn: (s) => s.closeUpKind === 'dictionary',
  },
  {
    id: 'close',
    target: null,
    title: 'Now fix it',
    body: 'Close the panels (✕, or click outside them) and we will run the same query with one thing changed.',
    waitFor: (s) => s.closeUpDepth === 0,
    cta: 'Ready',
  },
  {
    id: 'prefix',
    target: '[data-tour="fuzzy-prefix"]',
    placement: 'right',
    title: 'Pin the first two characters',
    body: 'Set prefix_length to 2, then hit Search again. This says: still one edit, but not in the first two characters. Same typo tolerance everywhere it usually matters — people rarely fumble the start of a word.',
    waitFor: (s) => s.closeUpDepth === 0 && !s.playing,
    advanceOn: (s) => s.fuzzyPrefix === 2 && s.opQuery === 'serch~' && !s.opDone,
  },
  {
    id: 'magnify-prefix',
    target: '[data-tour="magnify"]',
    placement: 'bottom',
    title: 'Same answer, a fraction of the work',
    waitFor: (s) => s.fuzzyPrefix === 2 && s.opStepKey === 'local',
    onShow: (s, actions) => actions.pause(),
    body: 'Open the shard 🔍 again. The replay seeks instead of scanning, and the examined count is a fraction of what it was — 5 terms of 24 on this segment rather than all of them. It still finds “search”. One knob, same result, an order of magnitude less dictionary read.',
    advanceOn: (s) => s.closeUpKind === 'shard' || (s.opDone && !s.playing),
  },
  {
    id: 'resume',
    target: '[data-tour="stepper-play"]',
    placement: 'top',
    title: 'Run it out',
    body: 'Close the panel and press ▶ Play to finish the search.',
    waitFor: (s) => s.closeUpDepth === 0,
    highlightPlay: true,
    advanceOn: (s) => s.opType === 'search' && s.opDone && !s.playing,
  },
  {
    id: 'false-positive',
    target: '[data-tour="search-area"]',
    placement: 'right',
    title: 'Now the other cost',
    body: 'We have filled in “store~1” and cleared the prefix. Hit Search, then read what it expanded to on the shard panel or in the step blurb.',
    waitFor: (s) => s.closeUpDepth === 0 && !s.playing,
    onShow: (s, actions) => {
      actions.setFuzzyPrefix(0)
      actions.setQuery('store~1')
    },
    advanceOn: (s) => s.opQuery === 'store~1',
  },
  {
    id: 'read-expansion',
    target: '[data-tour="cluster"]',
    placement: 'left',
    title: '“score” is one edit from “store”',
    waitFor: (s) => s.opQuery === 'store~1' && s.opStepsDone.includes('local'),
    onShow: (s, actions) => actions.pause(),
    body: 'It expanded to score, store and stores. “score” has nothing whatever to do with what you asked for — it is simply one character away. Fuzzy matching compares spelling, not meaning, and it has no way to tell a typo from a different word. Documents about scoring are now in your results, and on this dataset one of them ranks first.',
    cta: 'Got it',
  },
  {
    id: 'finish',
    target: null,
    title: 'Using it without regretting it',
    body: [
      'Fuzziness.AUTO is the sane default: no edits below 3 characters, one up to 5, two beyond. A fixed ~2 on short words matches almost everything.',
      'Set prefix_length to 1 or 2 unless you genuinely expect the first letter to be wrong. It costs you almost no recall and it is the difference between seeking the dictionary and reading all of it, on every segment, on every shard.',
      'And remember what it cannot do: fuzzy is not stemming and not a synonym list. “search~2” finds “searched” by accident of spelling, not because it knows they are related — which is also why it finds “score” when you wanted “store”.',
    ],
    waitFor: (s) => s.closeUpDepth === 0,
    cta: 'Done',
  },
]

export default {
  id: 'fuzzy',
  label: 'How a typo still finds the document',
  blurb:
    'Fuzzy search, what it costs without prefix_length, and the words it matches that you never meant.',
  steps: STEPS,
  setup: (actions) => {
    actions.reset()
    actions.setFuzzyPrefix(0)
  },
}
