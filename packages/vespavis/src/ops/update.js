import { bucketOf, bucketReplicas } from '../cluster'

// The `update` op: a partial update to ONE field.
//
// The whole op exists to make one comparison land, and it is a comparison
// between two kinds of field in the SAME schema:
//
//   attribute field  →  the value is overwritten in place, in memory. No index
//                       work, no document-store read, no rewrite of anything.
//                       Tens of thousands of updates per second per node, and
//                       the new value is live in ranking, sorting and grouping
//                       on the very next query.
//
//   index field      →  the document is read back out of the document store,
//                       the field is changed, the whole document is written
//                       back and indexed again. Orders of magnitude more
//                       expensive, and it leaves the old entry behind in a disk
//                       index for a fusion to reclaim.
//
// The difference is mutability. An index is written once and read many times, so
// its on-disk form is immutable and a change means rewriting it. An attribute is
// a live in-memory column that ranking, sorting and grouping read directly, so a
// change is an assignment. That is why real-time signals — click rates, stock
// levels, prices, a user's profile vector — belong in attributes.
//
// The step list is chosen by the field, so which path you took is visible in
// the footer before you read a word of the explanation.

const ATTRIBUTE_STEPS = [
  {
    key: 'receive',
    ms: 1400,
    title: '1 · A partial update arrives',
    blurb:
      'PUT /document/v1/… with {"fields": {"popularity": {"assign": 0.95}}}. Only the named field is sent; the rest of the document is never mentioned and never touched.',
  },
  {
    key: 'route',
    ms: 1500,
    title: '2 · Routed to the bucket, same as a put',
    blurb:
      'An update goes through the distributor exactly like a put: hash the id, find the bucket, send it to every replica. Placement does not depend on which fields are changing.',
  },
  {
    key: 'apply',
    ms: 2200,
    title: '3 · The attribute is assigned in place',
    blurb:
      'The field is an attribute — an in-memory column. Proton writes the new value straight into the column at the document’s local id. No posting list changes, no document read, no rewrite. This is what "write at memory speed" means.',
  },
  {
    key: 'visible',
    ms: 2000,
    title: '4 · Live in the next query',
    blurb:
      'Ranking, sorting and grouping read that column directly, so the new value counts on the very next query. This is why real-time signals belong in attributes.',
  },
]

const INDEX_STEPS = [
  {
    key: 'receive',
    ms: 1400,
    title: '1 · A partial update arrives',
    blurb:
      'PUT /document/v1/… naming one field. The request is the same size and shape as the cheap case — everything that follows is decided by the field’s indexing statement, not by the request.',
  },
  {
    key: 'route',
    ms: 1500,
    title: '2 · Routed to the bucket, same as a put',
    blurb:
      'Hash the id, find the bucket, send it to every replica. Placement does not depend on which fields are changing.',
  },
  {
    key: 'read',
    ms: 2200,
    title: '3 · Read the whole document back',
    blurb:
      'The field is an INDEX field, so there is no column to assign into. Proton has to reconstruct the document to reindex it — which means reading it out of the document store on disk. You sent one field; the cluster is now moving all of them.',
  },
  {
    key: 'reindex',
    ms: 2200,
    title: '4 · Analyze and index again',
    blurb:
      'The changed field is re-analyzed and written into the memory index as a new entry. The old postings are still sitting in whichever disk index holds them, because a disk index is immutable — a later fusion is what finally drops them.',
  },
  {
    key: 'writeback',
    ms: 1800,
    title: '5 · Write the document back',
    blurb:
      'The whole document is written back to the document store. This is the read-modify-write that attribute updates skip entirely, and it is the reason a field you update constantly is a field you want as an attribute.',
  },
  {
    key: 'visible',
    ms: 2000,
    title: '6 · Live in the next query',
    blurb:
      'The result is correct and it is immediate — Vespa is real-time either way. What differs is what it cost: two extra disk operations, a reindex, and space in a disk index that stays occupied until the next fusion.',
  },
]

export function updateStepsFor(payload) {
  return payload?.kind === 'index' ? INDEX_STEPS : ATTRIBUTE_STEPS
}

export default {
  type: 'update',
  label: 'Partial update',
  steps: ATTRIBUTE_STEPS,
  stepsFor: updateStepsFor,

  note(op) {
    const { field, value, kind, docType, userName } = op.payload
    if (kind === 'index')
      return `${field} is declared "indexing: summary | index". One field changed, and the cluster read a document off disk, reindexed it and wrote it back — plus an entry in a disk index that only a fusion can reclaim.`
    if (docType === 'user')
      return `${userName}’s profile is a tensor attribute with NO hnsw index — nothing ever nearest-neighbour-searches users. So there is no graph to repair: the new vector is one assignment to one cell, and the next recommendation uses it.`
    return `${field} = ${value}. An attribute assignment touches one cell of one in-memory column — nothing is re-indexed and nothing is rewritten on disk.`
  },

  derive(c, op) {
    const s = op.step
    const { id, field, value, kind } = op.payload
    const steps = updateStepsFor(op.payload)
    const applyAt = steps.findIndex((x) => x.key === (kind === 'index' ? 'reindex' : 'apply'))
    if (s < applyAt) return

    const doc = c.docs[id]
    if (!doc) return
    c.docs[id] = { ...doc, [field]: value }

    for (const nodeId of bucketReplicas(bucketOf(id))) {
      const node = c.nodes.find((n) => n.id === nodeId)
      if (!node) continue
      if (!node.translog.some((t) => t.kind === 'update' && t.id === id)) {
        node.serial += 1
        node.translog.push({ serial: node.serial, kind: 'update', id })
      }
      // The whole difference, in two lines. An attribute update touches no
      // index at all. An index update writes a NEW entry into the memory index
      // while the old one stays in its disk index until a fusion reclaims it —
      // which is also why the flush gauge starts filling after one.
      if (kind === 'index' && !node.memoryIndex.includes(id)) node.memoryIndex.push(id)
    }
  },

  extra(cluster, op) {
    const s = op.step
    const { id, kind } = op.payload
    const steps = updateStepsFor(op.payload)
    const bucket = bucketOf(id)
    const replicas = bucketReplicas(bucket)
    const keyAt = (k) => steps.findIndex((x) => x.key === k)
    return {
      update: {
        id,
        bucket,
        replicas,
        activeNode: replicas[0],
        kind,
        field: op.payload.field,
        from: op.payload.from,
        to: op.payload.value,
        docType: op.payload.docType,
        routed: s >= keyAt('route'),
        readingStore: kind === 'index' && s >= keyAt('read'),
        applied: s >= keyAt(kind === 'index' ? 'reindex' : 'apply'),
        visible: s >= keyAt('visible'),
      },
    }
  },
}
