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

// Deterministic stand-in for OpenSearch's murmur3(_routing) % num_shards.
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
// OpenSearch's adaptive replica selection (see SPEC "Flagged simplifications"):
// alternate by shard id so the demo shows both copy types serving.
export function selectServingCopy(shard) {
  return shard.id % 2 === 1
    ? { node: shard.replicaNode, role: 'replica' }
    : { node: shard.primaryNode, role: 'primary' }
}

export function initialCluster() {
  return {
    shards: SHARD_PLACEMENT.map((p) => ({
      ...p,
      buffer: [], // doc ids in the in-memory indexing buffer (not searchable)
      translog: [], // doc ids appended to the translog (durability log)
      segments: [], // { id, docIds, searchable, committed }
    })),
    docs: {}, // docId -> { id, title, body, tokens, deleted, color, shard }
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
