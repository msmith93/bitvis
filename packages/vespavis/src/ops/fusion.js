// The `fusion` op: several disk indexes are merged into one.
//
// Every flush leaves another disk index behind, and a query has to look in all
// of them. Fusion folds them into a single index — which is also the only thing
// that physically reclaims the space a removed document was using, since a disk
// index is immutable and cannot have entries taken out of it.
//
// Like flush, it is a maintenance job proton schedules for itself, and like
// flush it is invisible to a query: nothing appears or disappears from search
// when it runs. It changes how much you are paying, not what you can find.

import { nodeWillFuse } from '../cluster'

const STEPS = [
  {
    key: 'select',
    ms: 1800,
    title: '1 · Pick the indexes to fuse',
    blurb:
      'Proton’s fusion job selects the disk indexes to merge. Documents that have been removed since those indexes were written are identified here — their entries are still on disk, and dropping them is the other reason to run a fusion.',
  },
  {
    key: 'fuse',
    ms: 2000,
    title: '2 · One index, removed documents dropped',
    blurb:
      'The selected indexes are read together and written out as one. Removed documents are simply not written, which is how their space comes back. Fusion needs room for both the old and the new index while it runs, then the old ones are deleted.',
  },
]

export default {
  type: 'fusion',
  label: 'Fusion',
  steps: STEPS,

  derive(c, op) {
    if (op.step < 1) return
    const names = op.payload.newIndexes || {}
    for (const node of c.nodes) {
      if (!nodeWillFuse(node, c.docs)) continue
      const kept = []
      for (const idx of node.diskIndexes)
        for (const id of idx.docIds)
          if (c.docs[id] && !c.docs[id].removed && !kept.includes(id)) kept.push(id)
      node.diskIndexes = [{ id: names[node.id] || 'index.fusion.1', docIds: kept }]
    }
    // A document nothing references any more is finally gone from the model.
    for (const id of Object.keys(c.docs)) {
      if (!c.docs[id].removed) continue
      const anywhere = c.nodes.some(
        (n) =>
          n.ready.includes(id) ||
          n.memoryIndex.includes(id) ||
          n.diskIndexes.some((d) => d.docIds.includes(id)),
      )
      if (!anywhere) delete c.docs[id]
    }
  },

  extra(cluster) {
    return {
      fusion: {
        nodes: cluster.nodes.filter((n) => nodeWillFuse(n, cluster.docs)).map((n) => n.id),
        reclaimable: cluster.nodes.reduce(
          (t, n) =>
            t +
            n.diskIndexes.reduce(
              (k, d) => k + d.docIds.filter((id) => cluster.docs[id]?.removed).length,
              0,
            ),
          0,
        ),
      },
    }
  },
}
