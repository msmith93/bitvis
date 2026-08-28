// "object or nested — and what nested really costs"
//
// Runs the SAME catalog under two mappings and the SAME query against both. The
// only thing that changes is the mapping, which is the point: `object` answers
// the query wrongly and cheaply, `nested` answers it correctly and bills you for
// it three times over — once in documents, once per query, once per write.
//
// A mapping cannot be changed in place in Elasticsearch, so switching mappings
// here is a REINDEX: two entries in the Load-docs menu, not a toggle.
import { NESTED_QUERIES } from '../presets'

// Where the shard panel's own mini-stepper has to be for a step's subject to be
// ON SCREEN. Both queries here are conjunctive, so the panel's step list is
// analyze · lookup · postings · intersect · (join) · score · topk · return —
// `join` only on the nested dataset. scripts/check-models.mjs asserts these
// indices, so the tour cannot silently drift out of sync with the panel.
//
// The panel auto-plays, so waiting on one of these lands the tip exactly as its
// subject appears. But a reader who closes the panel early must NOT strand the
// tour: `atPanelStep` therefore passes as soon as the panel is gone, and the
// step just explains what would have been on screen. Same rule as a noDim step —
// anything that gates on the panel needs an escape when the panel is closed.
const PANEL_INTERSECT = 3
const PANEL_JOIN = 4

const atPanelStep = (n) => (s) => s.closeUpKind !== 'shard' || s.closeUpStep >= n

const TRAP = NESTED_QUERIES[0] // variants.color:red AND variants.size:XL
const CONTROL = NESTED_QUERIES[1] // variants.color:brown AND variants.size:M

const STEPS = [
  {
    id: 'welcome',
    target: null,
    title: 'object or nested?',
    body: [
      'A document with an array of sub-objects — a product with its variants, an order with its line items — can be mapped two ways, and the default is the one that quietly gives wrong answers.',
      'You will index the same twelve products twice, once each way, and run the same query against both. Then you will find out what the correct answer costs: in documents stored, in work per query, and in work per update.',
      'The short version: nested is not a feature you turn on, it is a bill you agree to pay.',
    ],
    cta: 'Show me',
    secondary: 'Skip for now',
  },

  // ---- act 1: what `object` mapping actually writes -----------------------
  {
    id: 'load-object',
    target: '[data-tour="load-docs"]',
    targetExtra: '[data-tour="load-docs-menu"]',
    dataset: 'catalog-object',
    placement: 'right',
    title: 'Index the catalog the default way',
    body: 'Open “Load docs” and pick “Catalog · object”. Twelve products, each with two to four variants — a colour, a size and a stock count apiece. The variants are a plain object, which is what you get if you never say otherwise.',
    advanceOn: (s) => s.sampleSet === 'catalog-object',
  },
  {
    id: 'stack-object',
    target: '[data-tour="cluster"]',
    placement: 'left',
    title: 'Twelve products, twelve Lucene docs',
    body: 'Count the chips: one per product, four of them on shard 0. An `object` field is flattened INTO its parent — the array of variants stops existing and its leaves become multi-valued fields, so Trail Runner’s three variants are one document holding every colour and every size together in one bag.',
    cta: 'Got it',
  },
  {
    id: 'run-trap-object',
    target: '[data-tour="search-area"]',
    placement: 'right',
    title: 'Ask for a red XL',
    body: 'We have filled in a query with two clauses, ANDed: colour red and size XL. Nothing in this catalog is a red XL. Hit Search.',
    waitFor: (s) => !s.playing,
    onShow: (s, actions) => {
      actions.setRouting('')
      actions.setQuery(TRAP)
    },
    advanceOn: (s) => s.opQuery === TRAP,
  },
  {
    id: 'magnify-object',
    target: '[data-tour="magnify"]',
    placement: 'bottom',
    title: 'Look at what it is matching against',
    waitFor: (s) => s.opQuery === TRAP && s.opStep === 2 && s.sampleSet === 'catalog-object',
    onShow: (s, actions) => actions.pause(),
    body: 'Click the highlighted 🔍 to open the shard that holds Trail Runner.',
    advanceOn: (s) => s.zoomShard != null || (s.opDone && !s.playing),
  },
  {
    id: 'look-object',
    target: '[data-tour="cluster"]',
    placement: 'left',
    noDim: true,
    holdPanel: true,
    title: 'The pairing is gone',
    // Let the panel play as far as its intersect step before saying anything —
    // that is the step that shows the verdict per clause.
    waitFor: atPanelStep(PANEL_INTERSECT),
    body: 'Trail Runner satisfies BOTH clauses — ✓ red, ✓ XL — so it survives. The two struck out beside it are correctly rejected: Ridge Fleece has an XL but no red, Meadow Tee a red but no XL. Now look at what Trail Runner actually stores, further down: `variants.color` is one list holding red, blue and black; `variants.size` is another holding S, XL and M. Three variants went in and three flat lists came out, with nothing linking a colour to the size it arrived with. So the query finds red, finds XL, and both are in this one document. It matches. There is no red XL, and no query can tell.',
    cta: 'Ouch',
  },
  {
    id: 'resume-object',
    target: '[data-tour="stepper-play"]',
    placement: 'top',
    title: 'Let it finish',
    body: 'Press ▶ Play to let the paused search run to the end, so the Search button is free for the next query.',
    waitFor: (s) => s.zoomShard == null && !s.coordZoom,
    highlightPlay: true,
    advanceOn: (s) => s.opType === 'search' && s.opDone && !s.playing,
  },
  {
    id: 'result-object',
    target: '[data-tour="cluster"]',
    placement: 'left',
    title: 'One result, and it is wrong',
    body: 'Trail Runner came back. It is a real document, it really does contain the term “red” and the term “xl”, and it is not a red XL. This is the failure mode people ship: not an error, not an empty page — a plausible answer.',
    cta: 'Now fix it',
  },

  // ---- act 2: what `nested` writes, and what it gets right ----------------
  {
    id: 'load-nested',
    target: '[data-tour="load-docs"]',
    targetExtra: '[data-tour="load-docs-menu"]',
    dataset: 'catalog-nested',
    placement: 'right',
    title: 'Reindex with variants mapped nested',
    body: 'Open “Load docs” again and pick “Catalog · nested”. Same twelve products, same ids, same routing — the only difference is one line of mapping. Note that this is a REINDEX: you cannot change a mapping in place, which is exactly why getting it wrong hurts.',
    waitFor: (s) => s.zoomShard == null && !s.coordZoom,
    advanceOn: (s) => s.sampleSet === 'catalog-nested',
  },
  {
    id: 'stack-nested',
    target: '[data-tour="cluster"]',
    placement: 'left',
    title: 'Same twelve products. Now count the chips.',
    body: 'Shard 0 held four Lucene docs a moment ago; it holds seventeen now. Every variant became its own hidden Lucene document, written as a contiguous block with the product itself LAST. The small dim chips are the children. You still have twelve products — you now have forty-four Lucene docs to store, merge and search.',
    cta: 'Got it',
  },
  {
    id: 'run-trap-nested',
    target: '[data-tour="search-area"]',
    placement: 'right',
    title: 'Ask for a red XL again',
    body: 'Exactly the same query as before, against exactly the same products. Hit Search.',
    waitFor: (s) => !s.playing,
    onShow: (s, actions) => actions.setQuery(TRAP),
    advanceOn: (s) => s.opQuery === TRAP && s.sampleSet === 'catalog-nested',
  },
  {
    id: 'result-nested',
    target: '[data-tour="cluster"]',
    placement: 'left',
    title: 'Nothing. Which is the right answer.',
    waitFor: (s) => s.opQuery === TRAP && s.opDone && !s.playing,
    body: 'The clauses still have to agree on one Lucene document — but a Lucene document is now a single variant. Red lives in one child, XL lives in a different child, and no child has both. The false positive is gone, and nothing about the query changed.',
    cta: 'So what did that cost?',
  },

  // ---- act 3: the bill ----------------------------------------------------
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
    body: 'This step is the hop. What matched is a VARIANT — brown, M — and it is rolled up to Dune Boot, the product you actually asked about; the stored _source below highlights both rows. Every nested match makes this trip, and where several variants of one product match they collapse into it together. Lucene does it through a bitset of “which docs are products”, built by scanning the whole segment even when one child matches, and cached per segment — so it goes cold again after every refresh. Object mapping pays none of it: the doc that matched was already the answer. From here on the shard has only documents; the coordinator never sees a variant.',
    cta: 'And the writes?',
  },
  {
    id: 'resume-control',
    target: '[data-tour="stepper-play"]',
    placement: 'top',
    title: 'Let it finish',
    body: 'Press ▶ Play to let this search finish and release the timeline.',
    waitFor: (s) => s.zoomShard == null && !s.coordZoom,
    highlightPlay: true,
    advanceOn: (s) => s.opType === 'search' && s.opDone && !s.playing,
  },
  {
    id: 'open-docs',
    target: '[data-tour="delete-doc"]',
    placement: 'right',
    title: 'Now change one variant',
    body: 'Open the document list. Every product carries a badge saying how many Lucene docs it really is — that number is about to be the whole point.',
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
      '`nested` is correct, and costs you a document per sub-object (watch `nested_objects.limit`, 10 000 per doc), a cached bitset and a join on every query, and a whole-block rewrite on every update.',
      'If you only ever query one field of the sub-object, you do not need nested at all — the flattening cannot hurt you, because there is no pair to get wrong. Nested earns its cost only when two clauses have to agree on the same sub-object.',
    ],
    cta: 'Done',
  },
]

export default {
  id: 'nested',
  label: 'object vs nested, and what nested costs',
  blurb:
    'The same catalog under two mappings: one answers a two-clause query wrongly, the other correctly — for a document per variant, a join per query and a block rewrite per update.',
  steps: STEPS,
  setup: (actions) => actions.reset(),
}
