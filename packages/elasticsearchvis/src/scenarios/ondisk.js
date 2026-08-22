// "What is a term dictionary actually made of?"
//
// The deepest lesson in the app, and the one that pays off the flat sorted table
// the other scenarios teach with. It drives the user down three zoom levels —
// cluster → shard → one segment's files — because the structures only exist at
// the bottom: an FST in memory, prefix-compressed blocks on disk, and a posting
// list that turns out to be bit-packed gaps rather than the doc ids it draws as.
//
// It merges first, deliberately: one big segment per shard gives the block tree
// enough terms to branch into sub-blocks and floor blocks, which two-doc segments
// never would.
const STEPS = [
  {
    id: 'welcome',
    target: null,
    title: 'What is a term dictionary actually made of?',
    body: [
      'Every other view in this app draws a segment’s dictionary as a flat sorted table. That is a useful lie. Underneath, it is two structures in two different files, and only one of them is ever in memory.',
      'The terms themselves live on disk in .tim, packed into blocks. What indexes them is a small graph called an FST in .tip, and its only job is to tell you which single block to read. You are about to take one apart.',
    ],
    cta: 'Take me down',
    secondary: 'Skip for now',
  },
  {
    id: 'load',
    target: '[data-tour="load-docs"]',
    targetExtra: '[data-tour="load-docs-menu"]',
    dataset: 'sample',
    placement: 'right',
    title: 'Load some documents',
    body: 'Open “Load docs” and pick “Sample docs”. We need a real dictionary with real terms in it — everything from here on is derived from these documents, not mocked up.',
    advanceOn: (s) => s.sampleSet === 'sample',
  },
  {
    id: 'merge',
    target: '[data-tour="merge"]',
    placement: 'right',
    title: 'Merge into one segment per shard',
    body: 'Click Merge. Each shard’s small segments become one bigger segment — which gives its term dictionary enough terms to branch into sub-blocks, exactly like a real one.',
    // Merge is disabled while another op's clock is running, and spotlighting a
    // disabled button is a dead end — the sample set tombstones a doc, so Refresh
    // is live too and an off-script click lands here. Wait for the timeline to be
    // idle so the ring only ever appears on a button that can actually be pressed.
    waitFor: (s) => !s.playing,
    advanceOn: (s) => s.opType === 'merge',
  },
  {
    id: 'search',
    target: '[data-tour="search-area"]',
    placement: 'right',
    title: 'Search for one ordinary term',
    body: 'We have put “search” in the box — no wildcard this time. Hit Search, and let it reach the local-search step.',
    // Search is disabled while a clock is running, so wait for the merge to have
    // both finished AND stopped playing.
    waitFor: (s) => (s.opType !== 'merge' || s.opDone) && !s.playing,
    onShow: (s, actions) => {
      actions.setRouting('')
      actions.setQuery('search')
    },
    advanceOn: (s) => s.opQuery === 'search',
  },
  {
    id: 'zoom-shard',
    target: '[data-tour="magnify"]',
    placement: 'bottom',
    title: 'Zoom 1: into a shard',
    waitFor: (s) => s.opQuery === 'search' && s.opStep === 2,
    onShow: (s, actions) => actions.pause(),
    body: 'Click the 🔍. This is the shard close-up you may already know: the segment anatomy at the bottom is the flat table we are about to take apart.',
    advanceOn: (s) => s.closeUpKind === 'shard',
  },
  // These two steps deliberately SPOTLIGHT rather than using centered cards: a
  // centered card sits over the middle of the screen, which is exactly where the
  // diagram the step is talking about lives. Anchored tips stay out of the way,
  // and the panel's own explain box does the per-step narrating from there.
  {
    id: 'zoom-dictionary',
    target: '[data-anat-dict]',
    placement: 'bottom',
    title: 'Zoom 2: into the term dictionary',
    // Only while the shard panel is the top of the stack — the 🔍 lives on it.
    waitFor: (s) => s.closeUpKind === 'shard',
    body: 'Scroll down to “Segment anatomy” and click the 🔍 on the “term dictionary” column head. One picture, four steps: the graph on the left is the index and it is in memory, the blocks on the right are the dictionary and they are on disk. Watch how much of the right-hand side gets read.',
    advanceOn: (s) => s.closeUpKind === 'dictionary',
  },
  {
    id: 'finish',
    target: null,
    title: 'Two structures, two files, one block read',
    // Waits for the whole stack to be closed, so the closing card never lands on
    // top of a panel the user is still reading.
    body: [
      'What you just watched is an FST: an automaton whose arrows are characters and whose circles can carry the address of a block. That is the structure Lucene uses to index the terms of a text field.',
      'And the reason it exists is the split you were looking at. The dictionary is far too large to hold in memory at real scale, so it stays on disk in blocks; what stays resident is a small graph that indexes those BLOCKS rather than the terms. Finding any term costs a walk through memory and a single block read — no matter how many terms there are.',
    ],
    waitFor: (s) => s.closeUpDepth === 0,
    cta: 'Done',
  },
]

export default {
  id: 'ondisk',
  label: 'Inside a segment’s term dictionary',
  blurb: 'Three zooms down to what an inverted index really is: an FST in .tip that picks one block of terms out of .tim.',
  steps: STEPS,
  setup: (actions) => actions.reset(),
}
