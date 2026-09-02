import {
  flightMs,
  FLIGHT_PAD_MS,
  INDEX_ANALYSIS_LEAD_MS,
  INDEX_REPLICA_HOP_MS,
} from '../timing'

// The `index` op: a document travels client → coordinator → primary shard,
// where it is analyzed, buffered + translogged — and then the DOCUMENT (not its
// terms) is replicated, and the replica does that same analysis itself.
// (Named indexOp.js so the file doesn't collide with ops/index.js.)

const STEPS = [
  {
    key: 'coordinator',
    ms: 1200,
    title: '1 · Coordinator receives the request',
    blurb:
      'The client sends an index request to a coordinator node (here, Node 1). Any node can coordinate.',
  },
  {
    key: 'route',
    ms: 1200,
    title: '2 · Route to the primary shard',
    blurb:
      'The coordinator hashes the document’s routing value to pick a shard: shard = hash(_routing) % number_of_shards, and _routing defaults to the _id. It forwards the document to that shard’s PRIMARY copy, which lives on one specific node.',
  },
  {
    key: 'analysis',
    ms: 2600, // overridden by duration() (scan + tokens-in-box + emit flight)
    title: '3 · Analysis (tokenize + normalize)',
    blurb:
      'On the primary shard, the analyzer tokenizes and lowercases each text field. Your sentences become the list of terms that will actually be indexed. Every copy of the shard does this for itself — watch step 5.',
  },
  {
    key: 'primary',
    ms: 1100,
    title: '4 · Primary buffer + translog',
    blurb:
      'The document is added to the primary shard’s in-memory buffer and appended to its translog. It is NOT searchable yet.',
  },
  {
    key: 'replicate',
    ms: 1500, // overridden by duration() (hop + scan + tokens-in-box + emit flight)
    title: '5 · Replicate — the replica indexes it too',
    blurb:
      'The primary forwards the operation to its replica copy on a DIFFERENT node. The replica performs the same indexing operation locally: it analyzes the document again, then buffers and translogs it. Only after the replica acknowledges does the coordinator ack the client.',
  },
]

export default {
  type: 'index',
  label: 'Indexing',
  steps: STEPS,

  // One line about THIS document's routing, shown under the step blurb. Step 2
  // can only state the rule ("_routing defaults to the _id"); this says which
  // value was actually hashed, so a doc indexed with a key is never narrated as
  // if its _id had chosen the shard.
  note(op) {
    const { doc } = op.payload
    const key = doc.routing
    return key
      ? `routing “${key}” → hash % 3 = shard ${doc.shard}. The _id (${doc.id}) was not used — every document sharing this key lands on the same shard.`
      : `no routing key → hash(${doc.id}) % 3 = shard ${doc.shard}.`
  },

  derive(c, op) {
    const s = op.step
    const { doc, block = [doc] } = op.payload
    for (const ld of block) c.docs[ld.id] = ld
    if (s >= 3) {
      const shard = c.shards.find((sh) => sh.id === doc.shard)
      // The whole block is buffered IN ORDER, children before the root. A block
      // is written atomically — Lucene has no way to add one child to a document
      // that is already indexed.
      for (const ld of block) {
        if (!shard.buffer.includes(ld.id)) shard.buffer.push(ld.id)
        if (!shard.translog.includes(ld.id)) shard.translog.push(ld.id)
      }
    }
  },

  extra(cluster, op) {
    const s = op.step
    const { doc } = op.payload
    return {
      inflight: {
        doc,
        shard: doc.shard,
        routed: s >= 1,
        analyzed: s >= 2,
        onPrimary: s >= 3,
        onReplica: s >= 4,
      },
    }
  },

  // Content-driven steps only; undefined falls back to the step's static `ms`.
  duration(op) {
    const { block = [op.payload.doc] } = op.payload
    // Every term the whole block emits — the field set comes from the document.
    const n = block.reduce(
      (t, ld) => t + Object.values(ld.tokens).reduce((k, terms) => k + terms.length, 0),
      0,
    )
    if (op.step === 2) return INDEX_ANALYSIS_LEAD_MS + flightMs(n) // scan + tokens-in-box + emit flight
    // The replicate step replays the whole analysis sequence at the replica, so
    // it budgets for step 2 all over again plus the doc's hop across the wire.
    if (op.step === STEPS.length - 1)
      return INDEX_REPLICA_HOP_MS + INDEX_ANALYSIS_LEAD_MS + flightMs(n) + FLIGHT_PAD_MS
    return undefined
  },
}
