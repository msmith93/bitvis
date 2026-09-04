import { bucketOf, bucketReplicas } from '../cluster'
import { flightMs, FLIGHT_PAD_MS, FEED_PROCESS_LEAD_MS } from '../timing'

// The `feed` op: one document Put, from HTTP request to queryable.
//
// Vespa is a real-time engine, and this op is where that is earned. The write
// lands directly in the structures a query reads — the attribute columns, the
// memory index, the HNSW graph — all of which are mutable and all of which are
// searched live. So the document is queryable a few milliseconds after the ack,
// and the write path has no visibility step of its own: making it findable is
// not a separate job, it is what the write already did.

const STEPS = [
  {
    key: 'receive',
    ms: 1300,
    title: '1 · A container receives the write',
    blurb:
      'POST /document/v1/catalog/product/docid/… arrives at any stateless container node. The container tier is where application code runs; it holds no data of its own.',
  },
  {
    key: 'process',
    ms: 2400, // overridden by duration() — analysis + embed + the token flight
    title: '2 · The indexing chain runs',
    blurb:
      'The document goes through the indexing pipeline the schema describes, IN THE CONTAINER: index fields are analyzed into terms, the embed expression turns text into a tensor, and attribute values are extracted. All of it happens before the document is sent anywhere.',
  },
  {
    key: 'route',
    ms: 1800,
    title: '3 · The distributor picks the bucket',
    blurb:
      'A distributor hashes the document id to a bucket, then runs the ideal-state algorithm to decide which content nodes hold that bucket. There is no placement table anywhere — the answer is recomputed from the id every time.',
  },
  {
    key: 'replicate',
    ms: 1600,
    title: '4 · Written to every replica',
    blurb:
      'The distributor sends the operation to ALL replicas of the bucket in parallel, and only acknowledges once enough of them have persisted it. Each content node appends it to its transaction log first — that log is what makes the write durable.',
  },
  {
    key: 'index',
    ms: 1700,
    title: '5 · Proton indexes it',
    blurb:
      'Proton puts the document in the Ready sub-database: terms into the in-memory index, attribute values into the in-memory column store, the vector into the HNSW graph, and the raw fields into the document store on disk. Every one of those is a live structure that queries read — which is why this step is the last one that matters for finding the document.',
  },
  {
    key: 'visible',
    ms: 2000,
    title: '6 · Queryable',
    blurb:
      'That is the whole write path. Everything it wrote — the attribute columns, the memory index, the HNSW graph — is mutable and is read live by queries, so the document is findable now, a few milliseconds after the client got its 200. Nothing else has to happen first.',
  },
]

export default {
  type: 'feed',
  label: 'Feed',
  steps: STEPS,

  note(op) {
    const { doc } = op.payload
    const b = bucketOf(doc.id)
    return `hash(${doc.id}) → bucket 0x${b.toString(16)} → ideal state ${bucketReplicas(b)
      .map((n) => `content-${n}`)
      .join(' + ')}. The first of those is the ACTIVE copy: it is the only one allowed to return this document from a query.`
  },

  derive(c, op) {
    const s = op.step
    const { doc } = op.payload
    const bucket = bucketOf(doc.id)
    // Step 2 is where the indexed form of the document comes into existence —
    // in the container, not on a content node. Vespa analyzes and embeds once,
    // in the indexing chain, and ships the RESULT; it does not ship the raw
    // document and make every replica redo the work.
    if (s >= 1) c.docs[doc.id] = { ...doc, bucket }
    if (s < 3) return
    for (const nodeId of bucketReplicas(bucket)) {
      const node = c.nodes.find((n) => n.id === nodeId)
      if (!node) continue
      if (!node.translog.some((t) => t.id === doc.id)) {
        node.serial += 1
        node.translog.push({ serial: node.serial, kind: 'put', id: doc.id })
      }
      if (s >= 4) {
        if (!node.ready.includes(doc.id)) node.ready.push(doc.id)
        if (!node.memoryIndex.includes(doc.id)) node.memoryIndex.push(doc.id)
      }
    }
  },

  extra(cluster, op) {
    const s = op.step
    const { doc } = op.payload
    const bucket = bucketOf(doc.id)
    const replicas = bucketReplicas(bucket)
    return {
      feed: {
        doc,
        bucket,
        replicas,
        activeNode: replicas[0],
        processed: s >= 1,
        routed: s >= 2,
        written: s >= 3,
        indexed: s >= 4,
        visible: s >= 5,
      },
    }
  },

  duration(op) {
    const { doc } = op.payload
    const n =
      (doc.terms?.title?.length || 0) + (doc.terms?.description?.length || 0)
    if (op.step === 1) return FEED_PROCESS_LEAD_MS + flightMs(n) + FLIGHT_PAD_MS
    return undefined
  },
}
