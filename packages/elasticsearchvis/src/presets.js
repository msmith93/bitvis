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

// The datasets offered by the "Load docs" menu, in menu order. Adding one is a
// single entry here — nothing in App.jsx or the menu component needs touching.
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
]
