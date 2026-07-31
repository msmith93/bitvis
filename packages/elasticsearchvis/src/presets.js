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

// Routing keys used by the routed sample set below (and its scenario).
export const ROUTING_KEYS = ['tenant-a', 'tenant-b', 'tenant-c']

// A larger curated set for the "Load sample docs" button. Routing (by doc id) puts
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
