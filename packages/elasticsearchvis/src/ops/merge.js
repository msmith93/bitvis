// The `merge` op: each shard's small searchable segments are consolidated into
// one, and docs whose deletes a refresh has already applied are physically
// reclaimed.

const dedupe = (arr) => [...new Set(arr)]

const STEPS = [
  {
    key: 'select',
    ms: 1300,
    title: '1 · Select segments to merge',
    blurb:
      'On each shard with several small segments, the merge picks them to combine into one. Any tombstoned (deleted) docs are identified here — this is where they get reclaimed.',
  },
  {
    key: 'merged',
    ms: 1400,
    title: '2 · One merged segment per shard',
    blurb:
      'The small segments are replaced by a single new, larger segment; the old ones are discarded and deleted docs are physically dropped. Both primary and replica copies merge.',
  },
]

export default {
  type: 'merge',
  label: 'Merge',
  steps: STEPS,

  derive(c, op) {
    const s = op.step
    if (s >= 1) {
      const newSegs = op.payload.newSegments
      for (const shard of c.shards) {
        const mergeable = shard.segments.filter((seg) => seg.searchable)
        if (mergeable.length < 2) continue
        const keep = []
        for (const seg of mergeable)
          for (const id of seg.docIds)
            if (!c.docs[id]?.purged) keep.push(id)
        // physically reclaim deletes a refresh has already applied; a tombstone
        // that hasn't been refreshed yet is still live and survives the merge
        for (const seg of mergeable)
          for (const id of seg.docIds)
            if (c.docs[id]?.purged) delete c.docs[id]
        const others = shard.segments.filter((seg) => !seg.searchable)
        shard.segments = [
          ...others,
          {
            id: newSegs[shard.id],
            docIds: dedupe(keep),
            searchable: true,
            committed: true,
          },
        ]
      }
    }
  },

  extra(cluster) {
    return {
      merge: {
        shards: cluster.shards
          .filter((sh) => sh.segments.filter((x) => x.searchable).length >= 2)
          .map((sh) => sh.id),
      },
    }
  },
}
