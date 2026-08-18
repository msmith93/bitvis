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

// The collection statistics BM25 needs, over ONE shard: how many documents it
// can currently search, their average length, and each term's document
// frequency. This is what a shard knows on its own — and scoring with it is
// exactly what makes plain query_then_fetch's relevance shard-dependent.
//
// Derived from the same searchable-segments view search uses, so a buffered or
// purged doc can no more affect a score than it can appear in a result.
// `docFreq` comes straight off shardInvertedIndex, whose rows already de-dupe a
// doc that appears in several segments.
export function shardStats(shard, docs) {
  const rows = shardInvertedIndex(shard, docs)
  const docIds = new Set()
  for (const seg of shard.segments) {
    if (!seg.searchable) continue
    for (const id of seg.docIds) {
      const doc = docs[id]
      if (doc && !doc.purged) docIds.add(id)
    }
  }
  let totalLength = 0
  for (const id of docIds) {
    const { title, body } = docs[id].tokens
    totalLength += title.length + body.length
  }
  const docFreq = {}
  for (const row of rows) docFreq[row.term] = row.docIds.length
  return {
    docCount: docIds.size,
    totalLength,
    avgFieldLength: docIds.size ? totalLength / docIds.size : 0,
    docFreq,
  }
}

// Sum per-shard stats into the collection-wide view. This is the pre-query round
// of dfs_query_then_fetch: docCounts and docFreqs add up across shards (a doc
// lives on exactly one shard, so nothing is double-counted), and the average
// length has to be recomputed from the totals rather than averaged.
export function mergeStats(statsList) {
  const docFreq = {}
  let docCount = 0
  let totalLength = 0
  for (const s of statsList) {
    docCount += s.docCount
    totalLength += s.totalLength
    for (const [term, n] of Object.entries(s.docFreq))
      docFreq[term] = (docFreq[term] || 0) + n
  }
  return {
    docCount,
    totalLength,
    avgFieldLength: docCount ? totalLength / docCount : 0,
    docFreq,
  }
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
