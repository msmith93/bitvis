// The `refresh` op: buffered docs become ONE new immutable, searchable segment
// per shard, and pending deletes are applied to the searchable view.

import { docRootId } from '../cluster'

const STEPS = [
  {
    key: 'write',
    ms: 1300,
    // The stepper already labels the op REFRESH, so the title doesn't repeat it.
    title: '1 · Buffers → new segments',
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

  // Further reading, shown under the explanation in "What's happening".
  docs: [
    {
      label: 'Near real-time search',
      url: 'https://www.elastic.co/docs/manage-data/data-store/near-real-time-search',
    },
    {
      label: 'Translog & flush',
      url: 'https://www.elastic.co/docs/reference/elasticsearch/index-settings/translog',
    },
  ],

  derive(c, op) {
    const s = op.step
    const newSegs = op.payload.newSegments
    for (const shard of c.shards) {
      if (shard.buffer.length === 0) continue
      // The buffer is copied IN ORDER, which is what keeps each document's block
      // contiguous and its root last: the ordinal a Lucene doc gets is its index
      // here. Never sort or regroup this.
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

  // The delete half of what derive() does, said only when there IS one. The
  // step blurbs stay about buffers and segments — a plain refresh should not
  // carry a sentence about deletes it isn't applying — so this rides on the
  // payload-note hook instead, and lands next to the chips visibly fading out.
  note(op, extra) {
    const n = extra.refresh?.pendingDeletes ?? 0
    if (!n) return null
    return `This refresh also applies ${n} pending delete${n === 1 ? '' : 's'}: ${
      n === 1 ? 'that document drops' : 'those documents drop'
    } out of search now, though ${
      n === 1 ? 'its entries stay' : 'their entries stay'
    } in the segment until a merge.`
  },

  extra(cluster) {
    // Every tombstone this refresh will apply: a searchable segment holding a
    // deleted-but-not-yet-purged doc. Collected as a Set of ROOT ids — counted
    // per Elasticsearch document, not per Lucene doc, since a nested block's
    // children are deleted with their root and would treble the number.
    // NOTE this reads the COMMITTED cluster, not the derived one, so the count
    // stays put once step 2 has actually applied the purges.
    const pendingByShard = new Map()
    for (const sh of cluster.shards)
      for (const seg of sh.segments) {
        if (!seg.searchable) continue
        for (const id of seg.docIds) {
          const d = cluster.docs[id]
          if (!d || !d.deleted || d.purged) continue
          if (!pendingByShard.has(sh.id)) pendingByShard.set(sh.id, new Set())
          pendingByShard.get(sh.id).add(docRootId(d))
        }
      }
    const pending = new Set([...pendingByShard.values()].flatMap((s) => [...s]))
    // Refresh touches a shard if it has buffered docs to segment OR a tombstone
    // to apply.
    const shards = cluster.shards
      .filter((sh) => sh.buffer.length > 0 || pendingByShard.has(sh.id))
      .map((sh) => sh.id)
    return { refresh: { shards, pendingDeletes: pending.size } }
  },
}
