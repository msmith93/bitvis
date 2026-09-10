// Example documents that deliberately share terms (search, elasticsearch, data,
// lucene…) so the same term turns up across multiple shards at search time.
// Four docs ensure all three shards get populated.
export const PRESETS = [
  {
    name: 'Elasticsearch intro',
    title: 'What is Elasticsearch',
    body: 'Elasticsearch is a distributed search and analytics engine for your data.',
  },
  {
    name: 'Lucene segments',
    title: 'Search with Lucene',
    body: 'Lucene stores searchable data in immutable segments built from an inverted index.',
  },
  {
    name: 'Logs use case',
    title: 'Analytics on logs',
    body: 'Teams search and analyze log data in Elasticsearch to find errors fast.',
  },
  {
    name: 'Cluster basics',
    title: 'Elasticsearch cluster',
    body: 'A cluster of nodes holds shards and replicas to scale search and store data.',
  },
]

export const EXAMPLE_QUERIES = ['search', 'data', 'elasticsearch lucene']

// Wildcard patterns for the "why are leading wildcards expensive?" scenario.
// `sc*` has a literal prefix, so a segment can seek to it; `*search` has none,
// and it deliberately matches two terms that sit far apart in the sorted
// dictionary ("elasticsearch" and "search") — visible proof that no seek exists.
export const WILDCARD_QUERIES = ['sc*', 'search*', '*search']

// Fuzzy patterns, one per thing worth knowing about fuzzy. All three are
// verified against the sample dictionaries by scripts/check-models.mjs:
//   serch~    a typo, corrected. A bare `~` is Fuzziness.AUTO, which at five
//             characters is 1 edit — so this matches "search" and nothing else.
//             The motivating case.
//   search~2  expands to search / searched / searches across the shards: proof
//             that a fuzzy query is a boolean OR over terms rather than one
//             lookup. NOT stemming — it found those by spelling, not meaning.
//   store~1   expands to score as well as store / stores. "score" is one edit
//             from "store" and has nothing to do with it. That is the honest
//             cost of fuzziness, and this chip exists to make it land.
export const FUZZY_QUERIES = ['serch~', 'search~2', 'store~1']

// Routing keys used by the routed sample set below (and its scenario).
export const ROUTING_KEYS = ['tenant-a', 'tenant-b', 'tenant-c']

// A larger curated set, the default entry in the "Load docs" menu. Routing (by doc id) puts
// 4 of these on shard 0, with deliberately different counts of the word "search"
// (4 / 3 / 2 / 1) so the close-up's scoring and top-k eviction are visible for the
// default `search` query. Ids are assigned doc-1..doc-N in array order.
export const SAMPLE_DOCS = [
  // doc-1 → shard 2
  { title: 'What is Elasticsearch', body: 'Elasticsearch is a distributed search and analytics engine for your data.' },
  // doc-2 → shard 0  ("search" ×4)
  { title: 'Search engine', body: 'search makes search fast: search across the cluster.' },
  // doc-3 → shard 1
  { title: 'Lucene segments', body: 'Lucene stores search data in immutable segments and powers search.' },
  // doc-4 → shard 2
  { title: 'Analytics on logs', body: 'Teams search and analyze log data to find errors fast.' },
  // doc-5 → shard 0  ("search" ×2)
  { title: 'Search and data', body: 'search across data in the cluster.' },
  // doc-6 → shard 1
  { title: 'Cluster basics', body: 'A cluster of nodes holds shards and replicas to scale search and store data.' },
  // doc-7 → shard 2
  { title: 'Distributed search', body: 'search runs on every shard then results merge; search scales out.' },
  // doc-8 → shard 0  ("search" ×1)
  { title: 'Operational logs', body: 'search logs and metrics for fast troubleshooting.' },
  // doc-9 → shard 1
  { title: 'Inverted index', body: 'an inverted index maps terms to documents to make search fast.' },
  // doc-10 → shard 2
  { title: 'Scaling out', body: 'add nodes to scale search and data across the cluster.' },
  // doc-11 → shard 0  ("search" ×3)
  { title: 'Search docs', body: 'search the data and search the logs.' },
  // The last three exist for the wildcard scenario: they seed "sc…" terms on
  // every shard (so a prefix seek has a range to walk) and put "elasticsearch"
  // alongside "search" on shards 0 and 1 (so `*search` matches two terms that
  // sit far apart in the sorted dictionary). None of them contains the bare term
  // "search", so the shard-0 top-k eviction demo above is unaffected.
  // doc-12 → shard 1
  { title: 'Scaling Elasticsearch', body: 'elasticsearch scales out: add nodes and searches stay fast.' },
  // doc-13 → shard 2
  { title: 'Score and schema', body: 'a schema maps the fields; the score ranks what you searched for.' },
  // doc-14 → shard 0
  { title: 'Searchable data in Elasticsearch', body: 'elasticsearch makes data searchable: scan the schema, score the results, keep searching.' },

  // ---- doc-15 onward: vocabulary, deliberately ----------------------------
  // These exist to make the term dictionary WIDE rather than to add documents
  // worth reading. A fuzzy query can only prune the index when the dictionary
  // has enough distinct words to make a block prefix discriminating: with the
  // fourteen docs above, every shard held 24-43 terms that were mostly
  // inflections of the same few stems, the .tip FST was two arcs deep, and a
  // one-edit automaton could not die inside it — `serch~` pruned NOTHING and
  // read 100% of shard 0. With these, each shard holds ~90-105 terms and the
  // same query prunes 11-17 arcs. SPEC.md records this as a requirement.
  //
  // Two rules when adding more:
  //   1. NEVER include the bare term "search". Shard 0's 4/3/2/1 term
  //      frequencies drive the close-up's top-k eviction demo, and one more
  //      scoring document there changes what it shows.
  //   2. Nothing may END in "search" but "search" and "elasticsearch" — the
  //      wildcard scenario's whole point is that `*search` matches exactly two
  //      terms sitting far apart in the sorted dictionary.
  // Routing cycles s1, s2, s0 from doc-15, so they are added in threes.
  //
  // doc-15 → shard 1
  { title: 'Refresh interval', body: 'a refresh makes recent writes visible; tune the interval to trade latency for throughput.' },
  // doc-16 → shard 2
  { title: 'Segment merging', body: 'merging rewrites many small segments into fewer larger ones and reclaims deleted docs.' },
  // doc-17 → shard 0
  { title: 'Scoring and relevance', body: 'relevance ranks documents; boosting a field changes which ones surface first.' },
  // doc-18 → shard 1
  { title: 'Translog durability', body: 'the translog records every write so a crash can replay uncommitted operations.' },
  // doc-19 → shard 2
  { title: 'Query clauses', body: 'a bool query combines must, should and filter clauses into one request.' },
  // doc-20 → shard 0
  { title: 'Caching filters', body: 'a filter cache remembers which documents matched so repeated clauses stay cheap.' },
  // doc-21 → shard 1
  { title: 'Mapping fields', body: 'a mapping declares field types: keyword, text, date, boolean and numeric.' },
  // doc-22 → shard 2
  { title: 'Analyzers and tokens', body: 'an analyzer splits text into tokens, lowercases them and strips punctuation.' },
  // doc-23 → shard 0
  { title: 'Shard sizing', body: 'oversharding wastes heap; undersharding limits parallelism, so size shards deliberately.' },
  // doc-24 → shard 1
  { title: 'Bulk indexing', body: 'bulk requests batch many documents into one round trip and reduce overhead.' },
  // doc-25 → shard 2
  { title: 'Replica allocation', body: 'the allocator places replicas on different nodes to survive a failure.' },
  // doc-26 → shard 0
  { title: 'Coordinating nodes', body: 'a coordinating node fans requests out, gathers replies and merges them.' },
  // doc-27 → shard 1
  { title: 'Aggregations', body: 'buckets and metrics summarise millions of rows without returning them.' },
  // doc-28 → shard 2
  { title: 'Snapshot and restore', body: 'snapshots copy segments to a repository so an index can be restored later.' },
  // doc-29 → shard 0
  { title: 'Index lifecycle', body: 'a lifecycle policy rolls indices over, shrinks them, then deletes the oldest.' },
  // doc-30 → shard 1
  { title: 'Ingest pipelines', body: 'a pipeline enriches documents before they are written, parsing and renaming fields.' },
  // doc-31 → shard 2
  { title: 'Circuit breakers', body: 'breakers reject requests that would exhaust the heap rather than crash the node.' },
  // doc-32 → shard 0
  { title: 'Monitoring a cluster', body: 'watch heap pressure, queue depth and merge throughput to spot trouble early.' },
]

// A deliberately LARGE set — 128 documents — whose only job is to overflow the
// query's `size`. Every document contains the term "search" (and most contain
// "data" / "lucene" / "cluster"), so a plain `search` or a fuzzy `seearch~`
// matches far more than the default size of 3 on every shard: the per-shard
// priority-queue eviction AND the coordinator's final cut are both obvious,
// which they are not on the 32-doc set above. Generated rather than
// hand-written — the point is volume and shared vocabulary, not curated prose —
// and referenced by nothing in the scenarios or scripts/check-models.mjs.
const LARGE_TOPICS = [
  ['Distributed search', 'a search request fans out to every shard and the partial results merge into one ranked list'],
  ['Inverted index', 'an inverted index maps each term to the documents that contain it, which is what makes search fast'],
  ['Lucene segments', 'Lucene keeps searchable data in immutable segments built from an inverted index'],
  ['Refresh and visibility', 'a refresh turns buffered writes into a new searchable segment about a second after they arrive'],
  ['Translog durability', 'the translog records every write so a crash can replay the operations a search has not seen yet'],
  ['Segment merging', 'merging folds many small segments into fewer large ones and drops the documents marked deleted'],
  ['Relevance scoring', 'BM25 ranks each document by term frequency and inverse document frequency before the top hits return'],
  ['Priority queue', 'each shard keeps only its highest-scoring hits in a small priority queue and evicts the rest'],
  ['Query then fetch', 'the query phase collects ids and scores from every shard, then the fetch phase pulls the winning documents'],
  ['Coordinating node', 'a coordinating node fans the search out, gathers the replies and merges them into one page'],
  ['Routing keys', 'a routing key sends every related document to the same shard so a search can go straight there'],
  ['Replica allocation', 'replicas are placed on different nodes so a search still succeeds when one node fails'],
  ['Analyzers and tokens', 'an analyzer lowercases the text and splits it into the tokens a search will look up'],
  ['Field mappings', 'a mapping declares whether a field is text, keyword, date or numeric, which changes how search treats it'],
  ['Bulk indexing', 'a bulk request batches many documents into one round trip so the data is searchable sooner'],
  ['Aggregations', 'aggregations summarise millions of rows without returning them, alongside the search hits'],
  ['Filter caching', 'a filter cache remembers which documents matched a clause so a repeated search stays cheap'],
  ['Shard sizing', 'oversharding wastes heap while undersharding limits how much a search can parallelise'],
  ['Index lifecycle', 'a lifecycle policy rolls an index over, shrinks it, then deletes the oldest data from search'],
  ['Snapshot and restore', 'a snapshot copies segments to a repository so the searchable data can be restored later'],
  ['Ingest pipelines', 'an ingest pipeline enriches a document before it is written and becomes searchable'],
  ['Circuit breakers', 'a circuit breaker rejects a search that would exhaust the heap rather than let the node crash'],
  ['Near real time', 'a document becomes searchable about a second after it is indexed, not the instant it is written'],
  ['Doc values', 'doc values store a column of a field on disk for sorting and aggregating the search results'],
  ['Highlighting', 'highlighting marks the query terms inside each document the search returns'],
  ['Pagination', 'from and size page through a search result one window at a time'],
  ['Search after', 'search after walks deep result sets a page at a time without holding a cursor open'],
  ['Text versus keyword', 'a text field is analysed for search while a keyword field matches the whole value exactly'],
  ['Cluster health', 'green, yellow and red describe how many shards are allocated to serve search and store data'],
  ['Shard rebalancing', 'the allocator moves shards between nodes to keep disk and search load even across the cluster'],
  ['Term dictionary', 'each segment sorts its terms so a prefixed search can seek straight to the range it needs'],
  ['Fuzzy matching', 'a fuzzy search matches every term within an edit distance of the query, not just the exact one'],
]
const LARGE_CLOSERS = [
  'search runs on every shard, then the coordinator merges what each one sent back',
  'the same search term turns up in segments across all three shards',
  'search scales out as nodes are added to the cluster',
  'a search is analysed, looked up per segment, then scored against the inverted index',
  'only the top hits of a search survive the priority queue on each shard',
  'search reads the data in immutable segments and never blocks a write',
]
export const LARGE_SAMPLE_DOCS = Array.from({ length: 128 }, (_, i) => {
  const [name, lead] = LARGE_TOPICS[i % LARGE_TOPICS.length]
  return {
    title: `${name} (${i + 1})`,
    body: `${lead}; ${LARGE_CLOSERS[i % LARGE_CLOSERS.length]}.`,
  }
})

// A second sample set for the routing scenario: every document carries an
// explicit routing key, so the shard comes from hash(routing) instead of
// hash(_id) — which is why all of a tenant's data ends up co-located on one
// shard. With the app's hash: tenant-a → shard 1, tenant-b → shard 2,
// tenant-c → shard 0. They all share the term "order" so an unrouted search
// genuinely has to visit every shard.
export const ROUTED_DOCS = [
  { routing: 'tenant-a', title: 'Order 1001 shipped', body: 'order 1001 shipped from the west warehouse.' },
  { routing: 'tenant-b', title: 'Order 2001 packed', body: 'order 2001 packed and awaiting pickup.' },
  { routing: 'tenant-c', title: 'Order 3001 refunded', body: 'order 3001 refunded after a damaged delivery.' },
  { routing: 'tenant-a', title: 'Order 1002 delayed', body: 'order 1002 delayed by a warehouse backlog.' },
  { routing: 'tenant-b', title: 'Order 2002 delivered', body: 'order 2002 delivered on time to the customer.' },
  { routing: 'tenant-c', title: 'Order 3002 returned', body: 'order 3002 returned by the customer for a refund.' },
  { routing: 'tenant-a', title: 'Order 1003 cancelled', body: 'order 1003 cancelled before the warehouse picked it.' },
  { routing: 'tenant-b', title: 'Order 2003 shipped', body: 'order 2003 shipped to the customer overnight.' },
  { routing: 'tenant-c', title: 'Order 3003 pending', body: 'order 3003 pending payment from the customer.' },
]

// Conjunctive, field-qualified queries — the only kind that can tell `object`
// mapping apart from `nested`, because the whole difference is whether two
// clauses are allowed to match different sub-objects.
//
//   red + XL     the trap. Under `object` this matches Trail Runner, which has a
//                red S and a blue XL and no red XL at all. Under `nested` it
//                correctly matches nothing.
//   brown + M    the control. Brown appears on exactly ONE variant in the whole
//                catalog (Dune Boot's brown M), so there is no product holding
//                brown and M on different variants and the two mappings must
//                agree — proof that nested didn't simply break the query. A
//                red+S control would NOT do: several products carry red and S on
//                different variants, so object over-matches there too and the
//                contrast stops being clean.
//   stock 0      a single clause, so there is nothing for the clauses to
//                disagree about: both mappings return the same two products.
export const NESTED_QUERIES = [
  'variants.color:red AND variants.size:XL',
  'variants.color:brown AND variants.size:M',
  'variants.stock:0',
]

// A product catalog whose `variants` are mapped `nested`. scripts/check-models.mjs
// also builds the `object` mapping of the same source JSON to contrast the two;
// the app only loads the nested form in bulk (the object form is walked one doc
// at a time in the index form).
//
// Three invariants, all asserted by scripts/check-models.mjs:
//   1. NO product anywhere has a variant that is both red AND XL. The lesson is
//      that `object` mapping reports a match that does not exist; if any real
//      red XL existed the query would be a true positive and teach nothing.
//   2. Exactly ONE product (doc-2, Trail Runner) holds red and XL on DIFFERENT
//      variants, so the false positive is a single, pointable document.
//   3. doc-2/5/8/11 route to shard 0 and carry 3/4/3/3 variants, so shard 0
//      holds 4 Lucene docs under `object` and 17 under `nested`. That 4-vs-17
//      is what the segment stack shows without any new UI.
// Ids are assigned doc-1..doc-N in array order, and routing is by _id.
export const CATALOG_DOCS = [
  // doc-1 → shard 2
  { name: 'Alpine Jacket', variants: [
    { color: 'olive', size: 'M', stock: 6 },
    { color: 'black', size: 'L', stock: 2 },
    { color: 'red', size: 'S', stock: 9 },
  ] },
  // doc-2 → shard 0 — THE TRAP: a red S and a blue XL, but never a red XL.
  { name: 'Trail Runner', variants: [
    { color: 'red', size: 'S', stock: 4 },
    { color: 'blue', size: 'XL', stock: 0 },
    // Trail Runner deliberately has TWO variants out of stock, so
    // `variants.stock:0` gives the join step a real N-to-1 collapse to draw:
    // two Lucene docs becoming the one product. With one match per product the
    // join renders as a row of 1 -> 1 everywhere and shows nothing merging.
    { color: 'black', size: 'M', stock: 0 },
  ] },
  // doc-3 → shard 1
  { name: 'Summit Pack', variants: [
    { color: 'sand', size: 'M', stock: 3 },
    { color: 'olive', size: 'L', stock: 5 },
  ] },
  // doc-4 → shard 2
  { name: 'River Sandal', variants: [
    { color: 'teal', size: 'S', stock: 8 },
    { color: 'sand', size: 'M', stock: 1 },
    { color: 'black', size: 'L', stock: 4 },
  ] },
  // doc-5 → shard 0  (4 variants)
  { name: 'Ridge Fleece', variants: [
    { color: 'blue', size: 'S', stock: 5 },
    { color: 'olive', size: 'M', stock: 2 },
    { color: 'sand', size: 'L', stock: 6 },
    { color: 'black', size: 'XL', stock: 0 },
  ] },
  // doc-6 → shard 1
  { name: 'Canyon Short', variants: [
    { color: 'khaki', size: 'M', stock: 4 },
    { color: 'teal', size: 'L', stock: 3 },
  ] },
  // doc-7 → shard 2
  { name: 'Basin Hoodie', variants: [
    { color: 'black', size: 'S', stock: 2 },
    { color: 'blue', size: 'M', stock: 9 },
    { color: 'olive', size: 'XL', stock: 1 },
  ] },
  // doc-8 → shard 0
  { name: 'Meadow Tee', variants: [
    { color: 'red', size: 'M', stock: 7 },
    { color: 'teal', size: 'L', stock: 3 },
    { color: 'sand', size: 'S', stock: 5 },
  ] },
  // doc-9 → shard 1
  { name: 'Glacier Mitt', variants: [
    { color: 'black', size: 'M', stock: 6 },
    { color: 'blue', size: 'L', stock: 2 },
  ] },
  // doc-10 → shard 2
  { name: 'Harbor Cap', variants: [
    { color: 'sand', size: 'S', stock: 4 },
    { color: 'red', size: 'L', stock: 8 },
  ] },
  // doc-11 → shard 0
  { name: 'Dune Boot', variants: [
    { color: 'brown', size: 'M', stock: 3 },
    { color: 'black', size: 'L', stock: 5 },
    { color: 'olive', size: 'S', stock: 2 },
  ] },
  // doc-12 → shard 1
  { name: 'Willow Scarf', variants: [
    { color: 'teal', size: 'M', stock: 6 },
    { color: 'red', size: 'L', stock: 1 },
  ] },
]

// The datasets offered by the "Load docs" menu, in menu order. Adding one is a
// single entry here — nothing in App.jsx or the menu component needs touching.
//
//   mapping   the object paths declared `nested`. Omitted (or empty) means every
//             sub-object is an `object` and gets flattened into its parent —
//             which is what every text dataset here already was.
//
//   id        also the value of the walkthrough snapshot's `sampleSet`, so a
//             scenario step advances with `(s) => s.sampleSet === '<id>'`
//   colorBy   which stage colour each doc gets. The default set colours by doc
//             so individual documents are followable; the routed set colours by
//             TENANT instead, which is what makes "everything with this routing
//             key lives on one shard" visible at a glance.
export const DATASETS = [
  {
    id: 'sample',
    label: 'Sample docs',
    blurb: '32 documents about search, spread across all three shards by _id.',
    docs: SAMPLE_DOCS,
    tombstoned: 'doc-8',
    colorBy: (d, i) => i,
  },
  {
    id: 'routed',
    label: 'Routed docs',
    blurb: 'Nine orders for three tenants, each indexed with its tenant as the routing key.',
    docs: ROUTED_DOCS,
    colorBy: (d, i) => {
      const tenant = ROUTING_KEYS.indexOf(d.routing)
      return tenant === -1 ? i : tenant
    },
  },
  // The nested lesson walks the `object` mapping one document at a time in the
  // index form; the loader only offers the bulk `nested` catalog, which is where
  // the costs show up. Loading it is a REINDEX, the honest way to model a
  // mapping change: you cannot change a mapping in place in Elasticsearch.
  {
    id: 'catalog-nested',
    label: 'Nested docs',
    blurb: 'The same 12 products with variants mapped nested — every variant becomes its own hidden Lucene doc.',
    docs: CATALOG_DOCS,
    mapping: ['variants'],
    colorBy: (d, i) => i,
  },
  // Volume, on purpose: enough matches per shard that the default size of 3
  // truncates the results at both the shard and the coordinator, where the
  // 32-doc set leaves every shard's queue under the limit.
  {
    id: 'large-sample',
    label: 'Larger sample docs',
    blurb: '128 documents about search — every shard holds far more than the default size of 3, so the top-hits cut is visible.',
    docs: LARGE_SAMPLE_DOCS,
    colorBy: (d, i) => i,
  },
]
