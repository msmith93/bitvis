// The `compact` op: on every up node with ≥2 SSTables, merge them into one —
// per key, the newest timestamp wins; shadowed versions and tombstones are
// physically dropped. Payload: { targets: [nodeId], names: { nodeId: sstId } }.

const STEPS = [
  {
    key: 'select',
    ms: 2600,
    title: '1 · Select SSTables to compact',
    blurb:
      'A node with several SSTables pays for it on every read (more tables to check) and in space (old versions and tombstones pile up, since SSTables are immutable). Compaction picks them to merge. Like flush, this is local and per-node — no coordination with the other replicas.',
  },
  {
    key: 'merge',
    ms: 2800,
    title: '2 · Merge: newest timestamp wins, tombstones reclaimed',
    blurb:
      'The SSTables merge into one: for each key, only the newest-timestamped version survives; older shadowed versions are dropped, and tombstones (with the values they shadow) are physically reclaimed — THIS is when a delete finally frees space. Real Cassandra keeps tombstones for gc_grace_seconds first, so a down replica can still learn about the delete before the marker disappears (else the old value could "resurrect" via repair).',
  },
]

export default {
  type: 'compact',
  label: 'Compact',
  steps: STEPS,

  derive(c, op) {
    const s = op.step
    const p = op.payload
    if (s >= 1) {
      for (const nid of p.targets) {
        const n = c.nodes[nid]
        // Merge oldest → newest so later (newer) tables overwrite earlier ones.
        const merged = {}
        for (const t of n.sstables) {
          for (const [k, e] of Object.entries(t.entries)) {
            if (!merged[k] || e.ts > merged[k].ts) merged[k] = e
          }
        }
        // Reclaim tombstones (gc_grace elided — see SPEC flagged simplifications).
        for (const k of Object.keys(merged)) if (merged[k].tombstone) delete merged[k]
        n.sstables = [{ id: p.names[nid], entries: merged }]
      }
    }
  },

  extra(cluster, op) {
    return {
      focus: op.payload.targets,
      flights: [],
      compact: { targets: op.payload.targets, selecting: op.step === 0 },
    }
  },
}
