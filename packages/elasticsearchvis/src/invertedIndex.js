// Pure derivations of what segments/shards physically store, for the UI's
// inverted-index views. No model change ever happens here.

// Sort a term->docIds Map into the [{term, docIds}] rows the UI renders.
const indexRows = (map) =>
  [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([term, ids]) => ({ term, docIds: [...ids] }))

// Build ONE segment's inverted index (term -> docIds). A tombstoned doc stays in
// the index until a refresh applies the delete (purged); only then does it leave.
export function segmentInvertedIndex(seg, docs) {
  const map = new Map()
  for (const id of seg.docIds) {
    const doc = docs[id]
    if (!doc || doc.purged) continue
    for (const field of ['title', 'body'])
      for (const term of doc.tokens[field]) {
        if (!map.has(term)) map.set(term, new Set())
        map.get(term).add(id)
      }
  }
  return indexRows(map)
}

// Build a shard's inverted index by merging its searchable segments' indexes.
export function shardInvertedIndex(shard, docs) {
  const map = new Map()
  for (const seg of shard.segments) {
    if (!seg.searchable) continue
    for (const { term, docIds } of segmentInvertedIndex(seg, docs)) {
      if (!map.has(term)) map.set(term, new Set())
      for (const id of docIds) map.get(term).add(id)
    }
  }
  return indexRows(map)
}

// What ONE segment physically stores, as data for the close-up's anatomy view:
// its inverted index (term dictionary + postings, via segmentInvertedIndex), the
// stored _source of each doc, and each doc's delete state (the live-docs bitset).
// Pure derivation — no model change. Includes purged docs in `docs` so the bitset
// can show them, even though segmentInvertedIndex omits them from `terms`.
export function segmentAnatomy(seg, docs) {
  return {
    id: seg.id,
    terms: segmentInvertedIndex(seg, docs),
    docs: seg.docIds
      .map((id) => docs[id])
      .filter(Boolean)
      .map((d) => ({
        id: d.id,
        title: d.title,
        body: d.body,
        deleted: !!d.deleted,
        purged: !!d.purged,
      })),
  }
}
