import { flightMs, FLIGHT_PAD_MS, INDEX_ANALYSIS_LEAD_MS } from '../timing'

// The `index` op: a document travels client → coordinator → primary shard,
// where it is analyzed, buffered + translogged, and replicated.
// (Named indexOp.js so the file doesn't collide with ops/index.js.)

const STEPS = [
  {
    key: 'coordinator',
    ms: 1200,
    title: '1 · Coordinator receives the request',
    blurb:
      'The client sends an index request to a coordinator node (here, Node 1). Any node can coordinate. Nothing has been routed or stored yet.',
  },
  {
    key: 'route',
    ms: 1200,
    title: '2 · Route to the primary shard',
    blurb:
      'The coordinator computes the target shard from the document id: shard = hash(_id) % number_of_shards. It forwards the document to that shard’s PRIMARY copy, which lives on one specific node.',
  },
  {
    key: 'analysis',
    ms: 2600, // overridden by duration() (scan + tokens-in-box + emit flight)
    title: '3 · Analysis (tokenize + normalize)',
    blurb:
      'On the primary shard, the analyzer tokenizes and lowercases each text field. Your sentences become the list of terms that will actually be indexed.',
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
    ms: 1500, // overridden by duration() (replica flight + dwell)
    title: '5 · Replicate to the replica',
    blurb:
      'The primary forwards the document to its replica copy on a DIFFERENT node, which buffers and logs it too. Only after the replica acknowledges does the coordinator ack the client. The data now lives on two nodes.',
  },
]

export default {
  type: 'index',
  label: 'Indexing',
  steps: STEPS,

  derive(c, op) {
    const s = op.step
    const { doc } = op.payload
    c.docs[doc.id] = doc
    if (s >= 3) {
      const shard = c.shards.find((sh) => sh.id === doc.shard)
      if (!shard.buffer.includes(doc.id)) shard.buffer.push(doc.id)
      if (!shard.translog.includes(doc.id)) shard.translog.push(doc.id)
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
    const { tokens } = op.payload.doc
    const n = tokens.title.length + tokens.body.length
    if (op.step === 2) return INDEX_ANALYSIS_LEAD_MS + flightMs(n) // scan + tokens-in-box + emit flight
    if (op.step === STEPS.length - 1) return flightMs(n) + FLIGHT_PAD_MS // replica flight
    return undefined
  },
}
