// The `merge` op: a shard's searchable segments are consolidated into one, and
// docs whose deletes a refresh has already applied (`purged`) are physically
// reclaimed. A shard merges when it has several segments to combine OR a single
// segment still carrying a purged doc — see `shardWillMerge`.

import { shardWillMerge } from '../cluster'

const dedupe = (arr) => [...new Set(arr)]

const STEPS = [
  {
    key: 'select',
    ms: 1300,
    title: '1 · Select segments to merge',
    blurb:
      'On each shard, the merge picks the searchable segments to fold into one. Docs whose delete a refresh has already applied are identified here — reclaiming them is the other reason to merge, so a shard with a single segment still merges if it holds one.',
  },
  {
    key: 'merged',
    ms: 1400,
    title: '2 · One merged segment per shard',
    blurb:
      'The selected segments are replaced by one new segment; the old ones are discarded and the deleted docs are physically dropped, reclaiming their space. Both primary and replica copies merge.',
  },
]

export default {
  type: 'merge',
  label: 'Merge',
  steps: STEPS,

  // Further reading, shown under the explanation in "What's happening".
  docs: [
    {
      label: 'Segment merging',
      url: 'https://www.elastic.co/docs/reference/elasticsearch/index-settings/merge',
    },
  ],

  derive(c, op) {
    const s = op.step
    if (s >= 1) {
      const newSegs = op.payload.newSegments
      for (const shard of c.shards) {
        if (!shardWillMerge(shard, c.docs)) continue
        const mergeable = shard.segments.filter((seg) => seg.searchable)
        // Segments are concatenated in order and each segment's own order is
        // preserved, so every block stays contiguous with its root last — and
        // every Lucene doc gets a NEW ordinal, because an ordinal is just an
        // index into this array. That renumbering is real: Lucene doc ids are
        // segment-local and a merge reassigns them.
        //
        // A purged doc is dropped, and a block is atomic, so a reclaimed
        // document takes all of its children with it — which is why merging
        // after a nested update reclaims v+1 docs rather than one.
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
          .filter((sh) => shardWillMerge(sh, cluster.docs))
          .map((sh) => sh.id),
      },
    }
  },
}
