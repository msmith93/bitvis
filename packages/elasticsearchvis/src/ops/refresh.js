// The `refresh` op: buffered docs become ONE new immutable, searchable segment
// per shard, and pending deletes are applied to the searchable view.

const STEPS = [
  {
    key: 'write',
    ms: 1300,
    title: '1 · Refresh: buffers → new segments',
    blurb:
      'A refresh writes each shard’s buffered documents into ONE new, immutable segment. If a buffer holds several docs, they all land in the same segment. Existing segments are never modified.',
  },
  {
    key: 'searchable',
    ms: 1300,
    title: '2 · Segments are now searchable',
    blurb:
      'The new segments become searchable and the buffers are cleared. The translog is kept until a flush. Refresh makes data visible to search — it does not yet make it durable.',
  },
]

export default {
  type: 'refresh',
  label: 'Refresh',
  steps: STEPS,

  derive(c, op) {
    const s = op.step
    const newSegs = op.payload.newSegments
    for (const shard of c.shards) {
      if (shard.buffer.length === 0) continue
      shard.segments.push({
        id: newSegs[shard.id],
        docIds: [...shard.buffer],
        searchable: s >= 1,
        committed: false,
      })
      if (s >= 1) shard.buffer = []
    }
    // A refresh also applies pending deletes: each tombstoned doc becomes
    // `purged`, leaving the searchable view (inverted index + search). It stays
    // physically in its segment until a merge reclaims it. Replace the doc object
    // (don't mutate) — cloneCluster shares doc refs with the committed cluster.
    // NOTE this loop is doc-global and sits OUTSIDE the per-shard loop above: a
    // refresh purges deletes even on shards with empty buffers (the
    // pending-delete-only refresh).
    if (s >= 1)
      for (const id of Object.keys(c.docs))
        if (c.docs[id].deleted && !c.docs[id].purged)
          c.docs[id] = { ...c.docs[id], purged: true }
  },

  extra(cluster) {
    // Refresh touches a shard if it has buffered docs to segment OR a tombstone
    // to apply (a searchable segment holding a not-yet-purged deleted doc).
    const hasPendingDelete = (sh) =>
      sh.segments.some(
        (seg) =>
          seg.searchable &&
          seg.docIds.some((id) => {
            const d = cluster.docs[id]
            return d && d.deleted && !d.purged
          }),
      )
    return {
      refresh: {
        shards: cluster.shards
          .filter((sh) => sh.buffer.length > 0 || hasPendingDelete(sh))
          .map((sh) => sh.id),
      },
    }
  },
}
