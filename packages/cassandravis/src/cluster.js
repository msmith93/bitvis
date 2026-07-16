// Cluster topology + state for the visualizer: a 64-position token ring, 4
// physical nodes × 2 vnodes each, replication factor 3 (SimpleStrategy).
// Unlike the sibling apps, ring tokens live IN cluster state (so a joining
// node can re-slice the ring) and node liveness is dynamic (`up`).

export const RING_SIZE = 64
export const N_REPLICAS = 3
export const VNODES_PER_NODE = 2

// The node a client connects to and that coordinates a request. Any node can
// coordinate — the coordinator is a peer, NOT a leader. It lives IN cluster
// state (`cluster.coordinator`): it starts at node-1 and moves only when the
// "crash the coordinator" scenario makes the client's driver pick another
// live peer. Ops read it from their payload (`p.coord`), captured at start().
const INITIAL_COORDINATOR = 'node-1'

// Consistency levels for N=3. W and R are how many acks the coordinator WAITS
// for — writes always go to all N replicas regardless.
export const CL = { ONE: 1, QUORUM: 2, ALL: 3 }
export const CL_NAMES = { 1: 'ONE', 2: 'QUORUM', 3: 'ALL' }

export const NODE_IDS = ['node-1', 'node-2', 'node-3', 'node-4']

// Node accent colors (ring ticks, arcs, card headers stay in sync).
export const NODE_COLORS = {
  'node-1': '#1287b1',
  'node-2': '#e0a04a',
  'node-3': '#4ec97a',
  'node-4': '#9b7fe0',
  'node-5': '#e0574a', // the addNode joiner
}

// Hand-interleaved tokens so a clockwise walk quickly yields 3 distinct
// physical nodes and a same-node vnode skip is easy to demonstrate.
const INITIAL_TOKENS = {
  'node-1': [0, 34],
  'node-2': [8, 42],
  'node-3': [16, 50],
  'node-4': [24, 58],
}

export function initialCluster() {
  return {
    coordinator: INITIAL_COORDINATOR,
    nodes: Object.fromEntries(
      NODE_IDS.map((id) => [
        id,
        {
          id,
          up: true,
          tokens: [...INITIAL_TOKENS[id]],
          commitLog: 0, // count of mutations since the last flush
          memtable: {}, // key -> { value, ts, tombstone }
          sstables: [], // [{ id, entries: { key -> { value, ts, tombstone } } }] newest LAST
          hints: [], // [{ forNode, key, value, ts, tombstone }] held for down replicas
        },
      ]),
    ),
    keys: {}, // key -> { color } display metadata for chips/key list
  }
}

export function cloneCluster(c) {
  return {
    coordinator: c.coordinator,
    keys: { ...c.keys },
    nodes: Object.fromEntries(
      Object.entries(c.nodes).map(([id, n]) => [
        id,
        {
          ...n,
          tokens: [...n.tokens],
          memtable: { ...n.memtable },
          sstables: n.sstables.map((t) => ({ ...t, entries: { ...t.entries } })),
          hints: [...n.hints],
        },
      ]),
    ),
  }
}

// Deterministic stand-in for Cassandra's Murmur3 partitioner: a simple string
// hash mod the ring size. For keys like user:1, cart:7 it spreads across the
// ring so different keys land on different replica sets.
export function hashKey(key) {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return h % RING_SIZE
}

// All vnode tokens on the ring, sorted clockwise: [{ token, node }].
export function ringTokens(cluster) {
  const out = []
  for (const n of Object.values(cluster.nodes))
    for (const t of n.tokens) out.push({ token: t, node: n.id })
  return out.sort((a, b) => a.token - b.token)
}

// THE core placement function (SimpleStrategy): walk clockwise from the key's
// token and take the first N DISTINCT physical nodes — a vnode belonging to an
// already-chosen node is skipped. Returns the full annotated walk so the Ring
// component can animate exactly what this function computed:
//   { token, replicas: [nodeId], walk: [{ token, node, taken }] }
// The walk ends at the stop that completes the replica set.
export function replicaWalk(cluster, key) {
  const token = hashKey(key)
  const ring = ringTokens(cluster)
  const replicas = []
  const walk = []
  // first vnode at or clockwise-after the key's token
  let start = ring.findIndex((r) => r.token >= token)
  if (start === -1) start = 0
  for (let i = 0; i < ring.length && replicas.length < N_REPLICAS; i++) {
    const stop = ring[(start + i) % ring.length]
    const taken = !replicas.includes(stop.node)
    if (taken) replicas.push(stop.node)
    walk.push({ ...stop, taken })
  }
  return { token, replicas, walk }
}

export function replicasFor(cluster, key) {
  return replicaWalk(cluster, key).replicas
}

// Honest-but-simplified bloom filter: exact membership over the SSTable's
// keys. Real bloom filters can false-positive (never false-negative); the
// blurbs explain that — here "maybe" is always right so the trace stays clear.
export function bloomMightContain(sstable, key) {
  return key in sstable.entries
}

// A node's LOCAL read path: memtable first, then SSTables NEWEST-first,
// consulting each SSTable's bloom filter. Returns the newest entry seen plus
// the full trace the inspector renders:
//   { entry: {value,ts,tombstone}|null, source: 'memtable'|sstableId|null,
//     trace: [{ where, bloom?, hit, entry? }] }
// NOTE: real reads must merge candidates by timestamp; because our memtable
// always holds the newest write for a key that's in it, checking newest-first
// and comparing ts gives the same answer.
export function readValue(node, key) {
  const trace = []
  let best = null
  let source = null
  const mem = node.memtable[key]
  trace.push({ where: 'memtable', hit: !!mem, entry: mem || null })
  if (mem) {
    best = mem
    source = 'memtable'
  }
  for (let i = node.sstables.length - 1; i >= 0; i--) {
    const t = node.sstables[i]
    const maybe = bloomMightContain(t, key)
    const entry = maybe ? t.entries[key] : undefined
    trace.push({ where: t.id, bloom: maybe, hit: !!entry, entry: entry || null })
    if (entry && (!best || entry.ts > best.ts)) {
      best = entry
      source = t.id
    }
  }
  return { entry: best, source, trace }
}

// What a get(key) would return from this node right now, ignoring liveness —
// used to precompute read responses / divergence in payloads.
export function nodeEntryFor(node, key) {
  return readValue(node, key).entry ?? null
}
