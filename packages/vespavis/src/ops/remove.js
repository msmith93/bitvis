import { bucketOf, bucketReplicas } from '../cluster'

// The `remove` op. A removed document leaves the Ready sub-database at once,
// and a TOMBSTONE (id + timestamp) is kept in the Removed sub-database.
//
// The tombstone is not bookkeeping for its own sake. Replicas of a bucket are
// re-synchronized by comparing them and copying what one has and another does
// not. Without a record that this document was deliberately removed, the next
// bucket merge would look at a replica that still has it, conclude the other
// replica is missing data, and copy it back — resurrecting the document. The
// timestamp is what lets the merge tell "deleted later" from "never had it".

const STEPS = [
  {
    key: 'route',
    ms: 1500,
    title: '1 · Routed to the bucket’s replicas',
    blurb:
      'A remove is routed exactly like a put: hash the document id to its bucket, and send the operation to every replica of that bucket.',
  },
  {
    key: 'tombstone',
    ms: 2000,
    title: '2 · Ready → Removed',
    blurb:
      'The document’s meta entry moves out of the Ready sub-database and into the Removed sub-database as a tombstone: the id and the timestamp, nothing else. It stops being matchable the moment that happens.',
  },
  {
    key: 'reclaim',
    ms: 2100,
    title: '3 · Space comes back later',
    blurb:
      'The posting-list entries and the stored fields are still on disk; a later fusion drops them, and the document store compacts around them. The tombstone itself is pruned once it is older than any merge could care about.',
  },
]

export default {
  type: 'remove',
  label: 'Remove',
  steps: STEPS,

  derive(c, op) {
    const s = op.step
    const { id } = op.payload
    if (s < 1) return
    for (const nodeId of bucketReplicas(bucketOf(id))) {
      const node = c.nodes.find((n) => n.id === nodeId)
      if (!node) continue
      node.serial += 1
      if (!node.translog.some((t) => t.kind === 'remove' && t.id === id))
        node.translog.push({ serial: node.serial, kind: 'remove', id })
      node.ready = node.ready.filter((d) => d !== id)
      node.memoryIndex = node.memoryIndex.filter((d) => d !== id)
      if (!node.removed.some((r) => r.id === id))
        node.removed.push({ id, serial: node.serial })
    }
    // The document object SURVIVES, flagged. It has left the Ready sub-database
    // (so it can never match again) but its entries are still sitting in the
    // disk indexes, and the picture should show that they are — reclaiming them
    // is a separate job that has not run yet. Fusion is what finally drops it.
    if (c.docs[id]) c.docs[id] = { ...c.docs[id], removed: true }
  },

  extra(cluster, op) {
    const { id } = op.payload
    const bucket = bucketOf(id)
    return {
      remove: { id, bucket, replicas: bucketReplicas(bucket) },
    }
  },
}
