// Example documents that deliberately share terms (search, opensearch, data,
// lucene…) so the same term turns up across multiple shards at search time.
// Four docs ensure all three shards get populated.
export const PRESETS = [
  {
    name: 'OpenSearch intro',
    title: 'What is OpenSearch',
    body: 'OpenSearch is a distributed search and analytics engine for your data.',
  },
  {
    name: 'Lucene segments',
    title: 'Search with Lucene',
    body: 'Lucene stores searchable data in immutable segments built from an inverted index.',
  },
  {
    name: 'Logs use case',
    title: 'Analytics on logs',
    body: 'Teams search and analyze log data in OpenSearch to find errors fast.',
  },
  {
    name: 'Cluster basics',
    title: 'OpenSearch cluster',
    body: 'A cluster of nodes holds shards and replicas to scale search and store data.',
  },
]

export const EXAMPLE_QUERIES = ['search', 'data', 'opensearch lucene']

// A larger curated set for the "Load sample docs" button. Routing (by doc id) puts
// 4 of these on shard 0, with deliberately different counts of the word "search"
// (4 / 3 / 2 / 1) so the close-up's scoring and top-k eviction are visible for the
// default `search` query. Ids are assigned doc-1..doc-N in array order.
export const SAMPLE_DOCS = [
  // doc-1 → shard 2
  { title: 'What is OpenSearch', body: 'OpenSearch is a distributed search and analytics engine for your data.' },
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
]
