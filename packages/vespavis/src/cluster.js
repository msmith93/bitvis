// The topology this app simulates, and the pure functions that decide where a
// document lives.
//
// Four things about Vespa's shape, all of which the rest of this file depends
// on:
//
//   * The serving tier is split in two. A STATELESS CONTAINER cluster parses
//     queries, runs application components, merges results and runs the final
//     ranking phase; a STATEFUL CONTENT cluster stores the data and does the
//     matching. They scale independently.
//   * Documents are spread over BUCKETS, and buckets are placed on nodes by a
//     deterministic ideal-state algorithm (a variant of CRUSH). Nothing anywhere
//     keeps a per-document placement table — where a document lives is
//     recomputed from its id every time it is needed.
//   * Every content node participates in every query, because every node holds
//     some of the buckets. There is no copy-selection step to make.
//   * Exactly one replica of each bucket is ACTIVE. Only the active replica
//     produces query results; the others are up-to-date standbys.

// ---- Stateless container cluster -------------------------------------------
// Any container can serve any request — they are interchangeable and hold no
// state. We fix the entry point so the demo is repeatable.
export const CONTAINER_NODES = [
  { id: 'container-0', name: 'container-0' },
  { id: 'container-1', name: 'container-1' },
]
export const ENTRY_CONTAINER = 'container-0'

// ---- Content cluster --------------------------------------------------------
export const CONTENT_NODES = [
  { id: 0, name: 'content-0' },
  { id: 1, name: 'content-1' },
  { id: 2, name: 'content-2' },
  { id: 3, name: 'content-3' },
]

// <min-redundancy>2</min-redundancy>: every bucket is stored on two nodes.
export const REDUNDANCY = 2

// How many of those copies are INDEXED (in the Ready sub-database). When it
// equals REDUNDANCY every copy is searchable and the Not Ready sub-database
// stays empty, which is the Vespa Cloud default and what this app models.
export const SEARCHABLE_COPIES = 2

// ---- Buckets ----------------------------------------------------------------
// A bucket is a chunk of the document space, named by the leading bits of the
// document id's hash. Real Vespa splits and joins buckets as they grow and
// shrink (the number of "used bits" changes); this app fixes the split level so
// the picture stays still — see SPEC.md "Flagged simplifications".
export const BUCKET_BITS = 3
export const NUM_BUCKETS = 1 << BUCKET_BITS

// A stable 32-bit string hash: FNV-1a with murmur3's finalizer on the end.
// Stands in for the 64-bit location Vespa computes from a document id.
//
// The finalizer is not decoration. Plain FNV-1a over `bucket:node` strings that
// differ in one character leaves the DIFFERENCES between the four nodes' draws
// almost constant, so the ranking came out the same for every bucket and the
// cluster degenerated into two fixed pairs of nodes — a placement table drawn
// as if it were an algorithm. Avalanching the result is what makes the ideal
// state actually look pseudo-random, which is the property being taught.
function fmix32(h) {
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b) >>> 0
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35) >>> 0
  h ^= h >>> 16
  return h >>> 0
}

export function hash32(s) {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return fmix32(h)
}

// Which bucket a document id falls in. This is the ONLY thing that decides
// where a document lives — there is no lookup table anywhere in the system.
export const bucketOf = (docId) => hash32(docId) & (NUM_BUCKETS - 1)

// Pretty bucket name, in Vespa's own hex style: BucketId(0x…) is written
// `bucket 0x3` here so it reads as an identifier rather than an index.
export const bucketLabel = (b) => `0x${b.toString(16)}`

// The ideal state for a bucket: every content node ranked by a pseudo-random
// draw seeded from (bucket, node). The first REDUNDANCY nodes store it, and the
// FIRST of those is the active copy.
//
// This is the whole elasticity story in four lines. A node's draw for a bucket
// depends only on that pair, so adding or removing a node leaves every other
// node's draw untouched: the only buckets that move are the ones whose ranking
// actually changed. Vespa uses a variant of CRUSH for exactly this reason.
export function idealState(bucket) {
  return CONTENT_NODES.map((n) => ({
    node: n.id,
    draw: hash32(`${bucket}:${n.id}`),
  }))
    .sort((a, b) => b.draw - a.draw || a.node - b.node)
    .map((s) => s.node)
}

// The nodes that store a bucket, best copy first. Index 0 is the active one.
export const bucketReplicas = (bucket) => idealState(bucket).slice(0, REDUNDANCY)
export const bucketActiveNode = (bucket) => bucketReplicas(bucket)[0]

// Buckets a node stores, and the subset it is active for. Derived every time
// rather than stored, because in Vespa it genuinely is derived every time.
export function bucketsOn(nodeId) {
  const out = []
  for (let b = 0; b < NUM_BUCKETS; b++) {
    const reps = bucketReplicas(b)
    const i = reps.indexOf(nodeId)
    if (i >= 0) out.push({ bucket: b, active: i === 0 })
  }
  return out
}

// Which distributor owns a bucket. Distributors are stateless (they rebuild
// their bucket database by polling content nodes at startup) and each one owns
// a disjoint slice of the bucket space; we hash the bucket onto a distributor
// so the fan-out has a visible owner rather than appearing from nowhere.
export const distributorFor = (bucket) =>
  hash32(`d:${bucket}`) % CONTENT_NODES.length

// ---- Per-node Proton state --------------------------------------------------
// Proton is the search core running on each content node. It keeps one document
// database per document type, and each document database has three
// sub-databases. This app models one document type, so one of each:
//
//   ready     — indexed and searchable. Its documents have attributes in memory
//               and index-field postings in the memory index or a disk index.
//   notReady  — stored but NOT indexed. Only populated when searchable-copies
//               is lower than redundancy, which this app does not do by default.
//   removed   — tombstones: id + timestamp, kept so that a bucket merge cannot
//               resurrect a document another replica already deleted.
//
// `memoryIndex` and `diskIndexes` partition the index-field postings of the
// documents in `ready`. ATTRIBUTES ARE NOT PARTITIONED: an attribute lives in
// memory for every ready document from the moment it is written, which is why
// an attribute update needs no index work at all (see ops/update.js).
function emptyNode(n) {
  return {
    ...n,
    ready: [], // doc ids, in local-id (lid) order
    memoryIndex: [], // subset of `ready`: postings still only in RAM
    diskIndexes: [], // [{ id, docIds }] — flushed, immutable until fusion
    notReady: [],
    removed: [], // [{ id, serial }]
    translog: [], // [{ serial, kind, id }]
    serial: 0,
  }
}

export function initialCluster() {
  return {
    nodes: CONTENT_NODES.map(emptyNode),
    docs: {}, // id -> { id, title, body, category, popularity, embedding, bucket }
  }
}

export function cloneCluster(c) {
  return {
    docs: { ...c.docs },
    nodes: c.nodes.map((n) => ({
      ...n,
      ready: [...n.ready],
      memoryIndex: [...n.memoryIndex],
      diskIndexes: n.diskIndexes.map((d) => ({ ...d, docIds: [...d.docIds] })),
      notReady: [...n.notReady],
      removed: n.removed.map((r) => ({ ...r })),
      translog: n.translog.map((t) => ({ ...t })),
    })),
  }
}

// ---- Queries against the model ---------------------------------------------

// The documents a node will actually match on. Three filters, and all three are
// real:
//
//   * only the READY sub-database is searched at all;
//   * within it, only documents whose bucket this node is ACTIVE for may
//     produce results — drop that and every document is found twice on a
//     redundancy-2 cluster, which is exactly what the active flag prevents;
//   * and only documents of the type being queried. Proton keeps one document
//     database PER DOCUMENT TYPE, and the container rewrites a query into one
//     per type, so a product search never walks the user documents sharing the
//     same nodes and the same buckets.
export function activeReadyDocs(node, docs, type = 'product') {
  const active = new Set(
    bucketsOn(node.id)
      .filter((b) => b.active)
      .map((b) => b.bucket),
  )
  return node.ready.filter(
    (id) => docs[id] && active.has(docs[id].bucket) && docs[id].type === type,
  )
}

// Which node answers for a given document id right now — the active replica of
// its bucket. The container needs this to fetch one document by id, which is
// what a recommendation does before it can build its real query.
export function activeNodeFor(docId) {
  return bucketActiveNode(bucketOf(docId))
}

// Would a flush do any work here? Only if index-field postings are sitting in
// the memory index. An attribute-only write leaves this empty — one of the
// things the update op is there to show.
export const nodeWillFlush = (n) => n.memoryIndex.length > 0

// Would a fusion do any work? Fusion merges the disk indexes into one, so it
// needs at least two of them (or one holding documents that have since been
// removed, which fusion is what physically drops).
export function nodeWillFuse(n, docs) {
  if (n.diskIndexes.length >= 2) return true
  return n.diskIndexes.some((d) =>
    d.docIds.some((id) => !docs[id] || docs[id].removed),
  )
}

// ---- Seeding ----------------------------------------------------------------
// Fill the cluster from a corpus without walking every document through the
// feed op. Each document is placed on the nodes its bucket names, and the
// index-field postings are split across two disk indexes per node so a Fusion
// has something to merge on arrival. Nothing is left in the memory index: this
// is a cluster that has been running for a while and has flushed.
export function seedCluster(corpus, users = [], splits = 2) {
  const c = initialCluster()
  const byNode = Object.fromEntries(CONTENT_NODES.map((n) => [n.id, []]))
  // User documents are placed by exactly the same algorithm as products: same
  // hash, same buckets, same replicas, same nodes. They are a different document
  // TYPE, which is what keeps them out of a product query — not a different
  // cluster, a different shard, or a different anything.
  for (const src of [...corpus, ...users]) {
    const bucket = bucketOf(src.id)
    const doc = { ...src, bucket }
    c.docs[doc.id] = doc
    for (const n of bucketReplicas(bucket)) byNode[n].push(doc.id)
  }
  for (const node of c.nodes) {
    const ids = byNode[node.id]
    node.ready = [...ids]
    // Only documents with INDEX fields have anything to put in a disk index.
    // A user document is attributes only — its whole content lives in memory
    // columns — so it is in the Ready sub-database and in no index at all.
    // That is not a modelling shortcut; it is what its schema says.
    const indexed = ids.filter((id) => hasIndexFields(c.docs[id]))
    const per = Math.max(1, Math.ceil(indexed.length / splits))
    let k = 1
    for (let i = 0; i < indexed.length; i += per)
      node.diskIndexes.push({
        id: `index.flush.${k++}`,
        docIds: indexed.slice(i, i + per),
      })
    node.serial = ids.length
    // A running cluster's transaction log has already been pruned up to the
    // last flush, so a seeded node starts with an empty one.
  }
  return c
}

// Does this document have anything an index could hold? Products do (title and
// description are `indexing: ... | index`); users do not.
export const hasIndexFields = (d) => !!d && d.type !== 'user'
