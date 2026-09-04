// The `flush` op: the memory index becomes a disk index.
//
// Proton searches the memory index and the disk indexes together, so a flush is
// invisible to a query: nothing becomes searchable and nothing stops being
// searchable. What it buys is RAM back, a faster restart (the transaction log
// can be pruned up to the flushed serial number), and postings in a form built
// for reading rather than for being written to.
//
// It is a background job, not an API. Proton's flush engine decides when to run
// it from the flush strategy — `maxmemorygain`, `diskbloatfactor`, `maxage` —
// which is why this op is normally triggered by the memory-index gauge crossing
// its threshold rather than by anyone pressing anything.

import { nodeWillFlush } from '../cluster'

const STEPS = [
  {
    key: 'write',
    ms: 2000,
    title: '1 · Memory index → a new disk index',
    blurb:
      'The flush engine writes each node’s memory index out as a new disk index, and flushes the attribute vectors alongside it. Queries keep running against both the memory index and the disk indexes throughout — this changes nothing about what can be found.',
  },
  {
    key: 'prune',
    ms: 1800,
    title: '2 · Memory reclaimed, transaction log pruned',
    blurb:
      'The memory index is dropped and its RAM comes back. Everything up to the flushed serial number is now on disk, so the transaction log can be pruned to that point — a restart replays only what came after.',
  },
]

export default {
  type: 'flush',
  label: 'Flush',
  steps: STEPS,

  derive(c, op) {
    const s = op.step
    if (s < 0) return
    const names = op.payload.newIndexes || {}
    for (const node of c.nodes) {
      if (!nodeWillFlush(node)) continue
      node.diskIndexes.push({
        id: names[node.id] || `index.flush.${node.diskIndexes.length + 1}`,
        docIds: [...node.memoryIndex],
        fresh: s === 0,
      })
      if (s >= 1) {
        node.memoryIndex = []
        node.translog = []
      }
    }
  },

  note(op) {
    if (!op.payload.auto) return null
    return `Nobody asked for this. A node's memory index passed the flush strategy's budget, so proton's flush engine started a flush by itself — which is the only way a flush ever happens.`
  },

  extra(cluster) {
    return {
      flush: {
        nodes: cluster.nodes.filter(nodeWillFlush).map((n) => n.id),
        docs: cluster.nodes.reduce((t, n) => t + n.memoryIndex.length, 0),
      },
    }
  },
}
