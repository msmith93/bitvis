// Cluster topology for the visualizer: a single index with 3 primary shards and
// 1 replica each, spread across 3 nodes. A replica is never placed on the same
// node as its primary, so every shard's data lives on two different nodes.

export const NODES = [
  { id: 'node-1', name: 'Node 1' },
  { id: 'node-2', name: 'Node 2' },
  { id: 'node-3', name: 'Node 3' },
]

export const NUM_SHARDS = 3

// Balanced placement: each node holds one primary and one replica (of a
// different shard).  node-1: P0,R2  ·  node-2: P1,R0  ·  node-3: P2,R1
export const SHARD_PLACEMENT = [
  { id: 0, primaryNode: 'node-1', replicaNode: 'node-2' },
  { id: 1, primaryNode: 'node-2', replicaNode: 'node-3' },
  { id: 2, primaryNode: 'node-3', replicaNode: 'node-1' },
]

// The node a client connects to and that coordinates a request. Any node can be
// a coordinator; we fix it to node-1 for a clear, repeatable demo.
export const COORDINATOR = 'node-1'

// Which shard copies a node hosts, with role. e.g. node-1 -> [{shard:0,role:'primary'},{shard:2,role:'replica'}]
export function shardsOnNode(nodeId) {
  const out = []
  for (const p of SHARD_PLACEMENT) {
    if (p.primaryNode === nodeId) out.push({ shard: p.id, role: 'primary' })
    if (p.replicaNode === nodeId) out.push({ shard: p.id, role: 'replica' })
  }
  return out
}

// Deterministic stand-in for Elasticsearch's murmur3(_routing) % num_shards.
// A simple string hash; for ids like doc-1, doc-2, doc-3 it spreads evenly
// across all shards so every node participates in the search demo.
export function routeShard(routingValue) {
  let h = 0
  for (let i = 0; i < routingValue.length; i++)
    h = (h * 31 + routingValue.charCodeAt(i)) >>> 0
  return h % NUM_SHARDS
}

// The value actually hashed for a document: its custom routing key if one was
// supplied at index time, else its _id. This is the whole mechanism — every doc
// sharing a routing key lands on the same shard, which is what lets a search
// with the same key skip the other shards entirely.
export const docRoute = (doc) => routeShard(doc?.routing || doc?.id || '')

// Which copy of a shard serves the query phase. Deterministic stand-in for
// Elasticsearch's adaptive replica selection (see SPEC "Flagged simplifications"):
// alternate by shard id so the demo shows both copy types serving.
export function selectServingCopy(shard) {
  return shard.id % 2 === 1
    ? { node: shard.replicaNode, role: 'replica' }
    : { node: shard.primaryNode, role: 'primary' }
}

// ---- Lucene documents vs Elasticsearch documents ------------------------
//
// A segment does not store Elasticsearch documents; it stores LUCENE documents,
// addressed by a segment-local ordinal 0..maxDoc-1, and the posting lists hold
// those ordinals. `_id` is just a stored field. `seg.docIds` is therefore the
// segment's Lucene docs IN ORDINAL ORDER -- the ordinal IS the array index,
// which is why a merge renumbers them for free.
//
// One Elasticsearch document occupies a contiguous BLOCK of that array, with its
// root written LAST. A document with no nested field is a block of exactly one
// Lucene doc whose id is its `_id`, so everything below degenerates to the flat
// 1:1 model the app had before nested existed.

// The `_id` a Lucene doc belongs to. A root is its own root.
export const docRootId = (d) => d?.root ?? d?.id ?? null

// Is this Lucene doc the block's root (the Elasticsearch document itself)?
export const isRootDoc = (d) => (d?.kind ?? 'root') === 'root'

// Would a merge do any work on this shard? Two reasons to merge, and either is
// enough: there are several searchable segments to fold into one, OR a single
// segment still carries a doc a refresh has already deleted (`purged`) — Lucene
// rewrites that segment to physically drop it and reclaim the space, which is
// what `_forcemerge?only_expunge_deletes=true` does. A tombstone a refresh has
// NOT applied yet is still live and is not a reason to merge.
export function shardWillMerge(shard, docs) {
  const searchable = shard.segments.filter((seg) => seg.searchable)
  if (searchable.length >= 2) return true
  return searchable.some((seg) => seg.docIds.some((id) => docs[id]?.purged))
}

// NOTE on the parent bitset. Lucene resolves a nested match to its document by
// walking a cached per-segment bitset (BitSetProducer) FORWARD from the matching
// child to the next set bit -- which is why the root must be written last. This
// app does not model that walk: `docRootId` above answers the same question
// directly, and the app has no ordinal arithmetic for a bitset to make cheaper.
// A `parentBitset` / `nextSetBit` pair and a diagram of them lived here and were
// REMOVED -- they duplicated the stored _source column (which already lists every
// Lucene doc, in ordinal order, children before their root, WITH its content),
// nothing but the test ever called them, and the picture implied postings hold
// integers while the column beside it rendered ids. The cost that mattered --
// the bitset is rebuilt per segment and goes cold on every refresh -- is a
// sentence in the step copy, which is where it belongs. Don't rebuild them
// without making the model actually walk one.

export function initialCluster() {
  return {
    shards: SHARD_PLACEMENT.map((p) => ({
      ...p,
      buffer: [], // Lucene doc ids in the in-memory indexing buffer (not searchable)
      translog: [], // Lucene doc ids appended to the translog (durability log)
      segments: [], // { id, docIds, searchable, committed } -- docIds in ordinal order
    })),
    // luceneDocId -> { id, root, kind, tokens, deleted, color, shard, ... }
    docs: {},
  }
}

export function cloneCluster(c) {
  return {
    docs: { ...c.docs },
    shards: c.shards.map((s) => ({
      ...s,
      buffer: [...s.buffer],
      translog: [...s.translog],
      segments: s.segments.map((seg) => ({ ...seg, docIds: [...seg.docIds] })),
    })),
  }
}
