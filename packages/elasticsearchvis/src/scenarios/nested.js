// "object or nested — and what nested really costs"
//
// The first two acts INDEX ONE DOCUMENT BY HAND, once under each mapping, so the
// reader makes the mapping decision themselves and watches it priced before they
// commit to it. One product is enough to produce the false positive, and far
// clearer than a dataset that arrives fully formed. Only the third act — the
// costs, which are about scale — loads the catalog.
//
// A mapping cannot be changed in place in Elasticsearch, so switching mappings
// means a REINDEX. This scenario clears the index between the two runs rather
// than pretending one index can hold both.
import { NESTED_QUERIES } from '../presets'
import { reviewResults } from './shared'

const TRAP = NESTED_QUERIES[0] // variants.color:red AND variants.size:XL
const CONTROL = NESTED_QUERIES[1] // variants.color:brown AND variants.size:M

// The document the reader indexes, both times. A red S and a blue XL and no red
// XL anywhere — the whole trap in one product.
const TRAIL_RUNNER = {
  title: 'Trail Runner',
  body: 'lightweight trail running shoe',
  variants: [
    { color: 'red', size: 'S' },
    { color: 'blue', size: 'XL' },
    { color: 'black', size: 'M' },
  ],
}

// Where the shard panel's own mini-stepper has to be for a step's subject to be
// ON SCREEN. Both queries here are conjunctive, so the panel's step list is
// analyze · lookup · postings · intersect · (join) · score · topk · return —
// `join` only on nested data. scripts/check-models.mjs asserts these indices, so
// the tour cannot silently drift out of sync with the panel.
//
// The panel auto-plays, so waiting on one of these lands the tip exactly as its
// subject appears. But a reader who closes the panel early must NOT strand the
// tour: `atPanelStep` therefore passes as soon as the panel is gone, and the
// step just explains what would have been on screen.
const PANEL_INTERSECT = 3
const PANEL_JOIN = 4
const atPanelStep = (n) => (s) => s.closeUpKind !== 'shard' || s.closeUpStep >= n

const STEPS = [
  {
    id: 'welcome',
    target: null,
    title: 'object or nested?',
    body: [
      'A document with an array of sub-objects — a product with its variants, an order with its line items — can be mapped two ways, and the default is the one that quietly gives wrong answers.',
      'You are going to index the same product twice, once each way, choosing the mapping yourself and seeing how the query behaves in each situation.',
    ],
    cta: 'Show me',
    secondary: 'Skip for now',
  },

  // ---- act 1: index it the default way, and get a wrong answer ------------
  {
    id: 'open-form-object',
    target: '[data-tour="index-doc"]',
    placement: 'right',
    title: 'Index a product by hand',
    body: 'Open the index form. We have filled in a shoe with three variants — a red S, a blue XL and a black M — and left the mapping at its default.',
    onShow: (s, actions) => {
      actions.setRouting('')
      actions.setIndexDoc({ ...TRAIL_RUNNER, nested: false })
    },
    advanceOn: (s) => s.indexPhase === 'editing',
  },
  {
    id: 'show-object-form',
    target: '[data-tour="index-card"]',
    placement: 'right',
    title: 'One document, one Lucene doc',
    body: 'Look at the Advanced section. `variants` is mapped `object` — the default you get by writing nothing about it — and the line underneath prices that: the whole product will be written as ONE Lucene document, because an `object` field is flattened into its parent. Press Index document.',
    advanceOn: (s) => s.opType === 'index',
  },
  {
    id: 'refresh-object',
    target: '[data-tour="refresh"]',
    placement: 'right',
    title: 'Make it searchable',
    body: 'The document is buffered, not searchable — one chip on its shard, and one on the replica. Click Refresh to write it into a segment.',
    waitFor: (s) => s.opType === 'index' && s.opDone && !s.playing,
    advanceOn: (s) => s.opType === 'refresh',
  },
  {
    id: 'run-trap-object',
    target: '[data-tour="search-area"]',
    placement: 'right',
    title: 'Ask for a red XL',
    body: 'Two clauses, ANDed: colour red and size XL. This shoe does not come in a red XL — it has a red S and a blue XL. Hit Search.',
    waitFor: (s) => (s.opType !== 'refresh' || s.opDone) && !s.playing,
    onShow: (s, actions) => actions.setQuery(TRAP),
    advanceOn: (s) => s.opQuery === TRAP,
  },
  {
    id: 'magnify-object',
    target: '[data-tour="magnify"]',
    placement: 'bottom',
    title: 'Look at what it is matching against',
    waitFor: (s) => s.opQuery === TRAP && s.opStep === 2,
    onShow: (s, actions) => actions.pause(),
    body: 'Click the highlighted 🔍 to open the shard holding it.',
    advanceOn: (s) => s.zoomShard != null || (s.opDone && !s.playing),
  },
  {
    id: 'look-object',
    target: '[data-tour="cluster"]',
    placement: 'left',
    noDim: true,
    holdPanel: true,
    title: 'The pairing is gone',
    waitFor: atPanelStep(PANEL_INTERSECT),
    body: 'read AND XL gets a response (which isn\'t what we wanted). Now look at what it actually stored in the stored-fields column. `variants.color` is one list holding red, blue and black; `variants.size` is another holding S, XL and M. Three variants went in and flat lists came out, with nothing linking a colour to the size it arrived with. So the query finds red, finds XL, and both are in this one document. It matches. There is no red XL, and no query can tell.',
    cta: 'Continue',
  },
  {
    id: 'resume-object',
    target: '[data-tour="stepper-play"]',
    placement: 'top',
    title: 'Resume the search',
    body: 'The search is still paused mid-flight. Press ▶ Play to resume it.',
    waitFor: (s) => s.zoomShard == null && !s.coordZoom,
    highlightPlay: true,
    advanceOn: (s) => s.opType === 'search' && s.opDone && !s.playing,
  },
  reviewResults('review-object'),
  {
    id: 'result-object',
    target: '[data-tour="cluster"]',
    placement: 'left',
    title: 'One result, and it is wrong',
    body: 'The shoe came back. It is a real document, it really does contain the term “red” and the term “xl”, and it is not a red XL. This is the failure mode you can run into if you don\'t understand how object types work.',
    cta: 'Now fix it',
  },

  // ---- act 2: the same product, mapped nested ----------------------------
  {
    id: 'open-form-nested',
    target: '[data-tour="index-doc"]',
    placement: 'right',
    title: 'Index a nested type instead',
    // Clearing the index is SETUP, not the thing being asked for: a mapping
    // cannot be changed in place, so there is no honest way to hold both
    // mappings at once. The body says so, rather than letting it look arbitrary.
    onShow: (s, actions) => {
      actions.reset()
      actions.setIndexDoc({ ...TRAIL_RUNNER, nested: true })
    },
    body: 'We have cleared the index. Open the form again; the same product is waiting, with `variants` now mapped as `nested`.',
    advanceOn: (s) => s.indexPhase === 'editing',
  },
  {
    id: 'show-nested-form',
    target: '[data-tour="index-card"]',
    placement: 'right',
    title: 'Same product. Four Lucene docs.',
    body: 'Nothing about the product changed — same title, same three variants. Only the mapping did, and the price under it went from one Lucene document to four: one per variant, plus the product itself, written together as a single block with the product LAST. Press Index document.',
    advanceOn: (s) => s.opType === 'index',
  },
  {
    id: 'watch-nested-write',
    target: '[data-tour="cluster"]',
    placement: 'left',
    title: 'Four chips, one product',
    waitFor: (s) => s.opType === 'index' && s.opStep >= 3,
    onShow: (s, actions) => actions.pause(),
    body: 'Watch the buffer. Four Lucene documents got created out of the one document we indexed. The small dim ones are the variants, and the last is the product itself. You still have one ElasticSearch document, but there are four total Lucene documents.',
    cta: 'Got it',
  },
  {
    id: 'resume-nested-write',
    target: '[data-tour="stepper-play"]',
    placement: 'top',
    title: 'Finish the write',
    body: 'Press ▶ Play to let the block replicate. The replica gets the DOCUMENT, not these chips — it analyzes it and builds all four Lucene docs itself.',
    highlightPlay: true,
    advanceOn: (s) => s.opType === 'index' && s.opDone && !s.playing,
  },
  {
    id: 'refresh-nested',
    target: '[data-tour="refresh"]',
    placement: 'right',
    title: 'Make it searchable',
    body: 'Refresh again to write the whole block into a segment.',
    waitFor: (s) => !s.playing,
    advanceOn: (s) => s.opType === 'refresh',
  },
  {
    id: 'run-trap-nested',
    target: '[data-tour="search-area"]',
    placement: 'right',
    title: 'Ask for a red XL again',
    body: 'Exactly the same query, against exactly the same product. Hit Search.',
    waitFor: (s) => (s.opType !== 'refresh' || s.opDone) && !s.playing,
    onShow: (s, actions) => actions.setQuery(TRAP),
    advanceOn: (s) => s.opQuery === TRAP && s.opType === 'search',
  },
  {
    id: 'magnify-nested',
    target: '[data-tour="magnify"]',
    placement: 'bottom',
    title: 'Zoom in to the shard',
    waitFor: (s) => s.opQuery === TRAP && s.opStep === 2,
    onShow: (s, actions) => actions.pause(),
    body: 'Click the highlighted 🔍 to open the shard holding your four Lucene docs.',
    advanceOn: (s) => s.zoomShard != null || (s.opDone && !s.playing),
  },
  {
    id: 'look-nested',
    target: '[data-tour="cluster"]',
    placement: 'left',
    noDim: true,
    holdPanel: true,
    title: 'Two candidates, each failing a different clause',
    waitFor: atPanelStep(PANEL_INTERSECT),
    body: 'Both clauses still have to agree on one Lucene doc — but now a Lucene doc IS a variant. Two of them made the candidate list, and look at why each one dies: the red variant is an S, so it fails size; the XL variant is blue, so it fails colour. The black M matched neither term and was never a candidate at all. No single variant satisfies both clauses, so the walk never reaches the product they belong to.',
    cta: 'Got it',
  },
  {
    id: 'resume-nested',
    target: '[data-tour="stepper-play"]',
    placement: 'top',
    title: 'Resume the search',
    body: 'The search is still paused mid-flight. Press ▶ Play to resume it.',
    waitFor: (s) => s.zoomShard == null && !s.coordZoom,
    highlightPlay: true,
    advanceOn: (s) => s.opType === 'search' && s.opDone && !s.playing,
  },
  reviewResults('review-nested'),
  {
    id: 'result-nested',
    target: '[data-tour="cluster"]',
    placement: 'left',
    title: 'Nothing. Which is the right answer.',
    waitFor: (s) => s.opQuery === TRAP && s.opDone && !s.playing,
    body: 'Nothing came back. The false positive is gone, and not one thing about the query changed — only where its clauses were allowed to meet. That is the whole correctness half of the story.',
    cta: 'So what did that cost?',
  },

  // ---- act 3: the bill, which only shows up at scale ----------------------
  {
    id: 'load-catalog',
    target: '[data-tour="load-docs"]',
    targetExtra: '[data-tour="load-docs-menu"]',
    dataset: 'catalog-nested',
    placement: 'right',
    title: 'Now at scale',
    body: 'One product makes the correctness point; the costs only show up in bulk. Open “Load docs” and pick “Catalog · nested” — twelve products with two to four variants each, mapped exactly the way you just mapped yours.',
    waitFor: (s) => s.zoomShard == null && !s.coordZoom,
    advanceOn: (s) => s.sampleSet === 'catalog-nested',
  },
  {
    id: 'stack-nested',
    target: '[data-tour="cluster"]',
    placement: 'left',
    title: 'Twelve products. Count the chips.',
    body: 'Forty-four Lucene documents, for twelve products you would recognise. Shard 0 alone holds seventeen where the object mapping would have held four. Every one of them is a document to store, to merge, and to walk past on every query — and `index.mapping.nested_objects.limit` caps you at 10 000 per document for exactly this reason.',
    cta: 'Got it',
  },
  {
    id: 'run-control',
    target: '[data-tour="search-area"]',
    placement: 'right',
    title: 'First, proof it still finds things',
    body: 'A pair that really does live on one variant: Dune Boot’s brown M. Brown appears exactly once in the whole catalog, so both mappings must agree on this one. Hit Search.',
    waitFor: (s) => !s.playing,
    onShow: (s, actions) => actions.setQuery(CONTROL),
    advanceOn: (s) => s.opQuery === CONTROL,
  },
  {
    id: 'magnify-control',
    target: '[data-tour="magnify"]',
    placement: 'bottom',
    title: 'Watch it get back to the product',
    waitFor: (s) => s.opQuery === CONTROL && s.opStep === 2,
    onShow: (s, actions) => actions.pause(),
    body: 'Click the highlighted 🔍. The match is on a CHILD — but you asked about a product, so something has to carry the answer back up.',
    advanceOn: (s) => s.zoomShard != null || (s.opDone && !s.playing),
  },
  {
    id: 'look-join',
    target: '[data-tour="cluster"]',
    placement: 'left',
    noDim: true,
    holdPanel: true,
    title: 'The block join — the tax on every query',
    waitFor: atPanelStep(PANEL_JOIN),
    body: 'This step is the hop. What matched is a VARIANT — brown, M — and it is rolled up to Dune Boot, the product you actually asked about; the stored fields below highlight both rows. Every nested match makes this trip, and where several variants of one product match they collapse into it together. Lucene does it through a bitset of “which docs are products”, built by scanning the whole segment even when one child matches, and cached per segment — so it goes cold again after every refresh.',
    cta: 'And the writes?',
  },
  {
    id: 'resume-control',
    target: '[data-tour="stepper-play"]',
    placement: 'top',
    title: 'Resume the search',
    body: 'The search is still paused mid-flight. Press ▶ Play to resume it.',
    waitFor: (s) => s.zoomShard == null && !s.coordZoom,
    highlightPlay: true,
    advanceOn: (s) => s.opType === 'search' && s.opDone && !s.playing,
  },
  reviewResults('review-control'),
  {
    id: 'open-docs',
    target: '[data-tour="delete-doc"]',
    placement: 'right',
    title: 'Now change one variant',
    body: 'Open the document list. Every product carries a badge saying how many Lucene docs it really is.',
    waitFor: (s) => s.zoomShard == null && !s.coordZoom,
    advanceOn: (s) => s.docsOpen,
  },
  {
    id: 'delete-block',
    target: '.docs-card',
    placement: 'left',
    title: 'A block is atomic',
    body: 'Delete any product — Trail Runner will do. Lucene cannot update one child of a block, or delete one: the unit is the whole block. Changing a single variant’s stock count means tombstoning every doc in that block and writing a fresh block of the same size. One field, four documents rewritten — and for a product with forty-eight variants, forty-nine.',
    advanceOn: (s) => s.tombstoned >= 2,
  },
  {
    id: 'merge-block',
    target: '[data-tour="merge"]',
    placement: 'right',
    title: 'And the merge pays for it too',
    body: 'Close the list and click Merge. The tombstoned docs are physically reclaimed — all of them, not one. Under object mapping that same edit would have cost a single tombstone and a single rewrite. This is why the rule of thumb is not “nested is slow”, it is: never put a frequently-updated array in a nested field.',
    waitFor: (s) => !s.docsOpen && !s.playing,
    advanceOn: (s) => s.opType === 'merge',
  },
  {
    id: 'finish',
    target: null,
    title: 'The trade, in one line',
    body: [
      '`object` is cheap and silently wrong for arrays of sub-objects: it flattens them together and answers questions about pairs that never existed.',
      '`nested` is correct, and costs you a document per sub-object, a cached bitset and a join on every query, and a whole-block rewrite on every update.',
      'If you only ever query ONE field of the sub-object, you do not need nested at all — the flattening cannot hurt you, because there is no pair to get wrong. Nested earns its cost only when two clauses have to agree on the same sub-object.',
    ],
    cta: 'Done',
  },
]

export default {
  id: 'nested',
  label: 'object vs nested',
  blurb:
    'See why a boolean query behaves differently on nested vs object mappings.',
  steps: STEPS,
  setup: (actions) => actions.reset(),
}
