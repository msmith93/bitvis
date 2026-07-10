// The `flush` op: on every up node with a non-empty memtable, the memtable is
// written out as ONE new immutable SSTable; then the memtable is cleared and
// the commit log truncated. Payload: { targets: [nodeId], names: { nodeId: sstId } }.

const STEPS = [
  {
    key: 'write',
    ms: 2600,
    title: '1 · Flush: memtable → a new SSTable',
    blurb:
      "Each node writes its memtable out as ONE new SSTable — a sorted, IMMUTABLE file with a bloom filter over its keys. Existing SSTables are never modified; this is the only way an SSTable is ever created. Flushing is a per-node, local decision (memtable full, commit log full) — replicas don't coordinate their flushes.",
  },
  {
    key: 'clear',
    ms: 2400,
    title: '2 · Memtable cleared, commit log truncated',
    blurb:
      'The data is now durable in the SSTable, so the memtable is cleared and the commit-log segments that covered it can be recycled. New writes start filling a fresh memtable; reads now find the flushed keys in the SSTable instead.',
  },
]

export default {
  type: 'flush',
  label: 'Flush',
  steps: STEPS,

  derive(c, op) {
    const s = op.step
    const p = op.payload
    for (const nid of p.targets) {
      const n = c.nodes[nid]
      if (s >= 0) {
        if (!n.sstables.some((t) => t.id === p.names[nid]))
          n.sstables.push({ id: p.names[nid], entries: { ...n.memtable } })
      }
      if (s >= 1) {
        n.memtable = {}
        n.commitLog = 0
      }
    }
  },

  extra(cluster, op) {
    return { focus: op.payload.targets, flights: [] }
  },
}
