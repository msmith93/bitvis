// Pure derivations of what segments/shards physically store, for the UI's
// inverted-index views. No model change ever happens here.

import { docRootId, isRootDoc } from './cluster'

// Sort a term->docIds Map into the [{term, docIds}] rows the UI renders.
const indexRows = (map) =>
  [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([term, ids]) => ({ term, docIds: [...ids] }))

// Build ONE segment's inverted index (term -> Lucene doc ids).
//
// A delete does not touch the term dictionary or the posting lists: the doc's
// entries physically stay on disk until a merge rewrites the segment. What a
// refresh does is set the doc's live-docs bit (here: `purged`) so search steps
// over it. So `includePurged` is the difference between the two honest views —
// what search can still reach (default) and what the segment actually stores
// (`true`, used by the shard close-up so a just-refreshed delete is shown struck
// through in its posting list rather than vanishing before the merge).
//
// The postings address LUCENE docs, so a nested child appears here in its own
// right -- that is the whole reason a nested query needs a join to get back to
// the document you asked for. The field set comes from the doc rather than a
// hardcoded pair, so a child's "variants.color" indexes like any other field.
export function segmentInvertedIndex(seg, docs, { includePurged = false } = {}) {
  const map = new Map()
  for (const id of seg.docIds) {
    const doc = docs[id]
    if (!doc) continue
    if (doc.purged && !includePurged) continue
    for (const terms of Object.values(doc.tokens))
      for (const term of terms) {
        if (!map.has(term)) map.set(term, new Set())
        map.get(term).add(id)
      }
  }
  return indexRows(map)
}

// Build a shard's inverted index by merging its searchable segments' indexes.
export function shardInvertedIndex(shard, docs, opts) {
  const map = new Map()
  for (const seg of shard.segments) {
    if (!seg.searchable) continue
    for (const { term, docIds } of segmentInvertedIndex(seg, docs, opts)) {
      if (!map.has(term)) map.set(term, new Set())
      for (const id of docIds) map.get(term).add(id)
    }
  }
  return indexRows(map)
}

// Fields holding SEVERAL values in one list -- the shape `object` mapping
// flattens an array of sub-objects into. Returned as [{ name, values }] so the
// view can draw the lists one under another; they are parallel and nothing pairs
// them up, which is the entire object-vs-nested lesson.
function multiValuedFields(fields) {
  if (!fields) return []
  return Object.entries(fields)
    .filter(([, v]) => Array.isArray(v) && v.length > 1)
    .map(([name, values]) => ({ name, values: values.map(String) }))
}

// What ONE segment physically stores, as data for the close-up's anatomy view:
// its inverted index (term dictionary + postings, via segmentInvertedIndex), the
// stored fields of each doc, and each doc's delete state (the live-docs bitset).
// Pure derivation — no model change. `includePurged` is on here: this view is
// "what the segment holds on disk", so a refreshed-but-not-merged delete still
// appears in its posting list (struck through), the same as it still appears in
// the stored _source rows below.
//
// Each doc carries its ORDINAL (its index in seg.docIds -- that is what a Lucene
// doc id is) plus whether it is a block root.
export function segmentAnatomy(seg, docs) {
  return {
    id: seg.id,
    terms: segmentInvertedIndex(seg, docs, { includePurged: true }),
    docs: seg.docIds
      .map((id, ord) => ({ d: docs[id], ord }))
      .filter(({ d }) => d)
      .map(({ d, ord }) => ({
        id: d.id,
        ord,
        root: docRootId(d),
        isRoot: isRootDoc(d),
        fields: d.fields ?? { title: d.title, body: d.body },
        label: d.label ?? d.title,
        detail: d.detail ?? d.body,
        // The MULTI-VALUED fields, as lists. This is what `object` mapping
        // produces and the only place it can be seen: one field holding every
        // sub-object's value for it, with nothing recording which arrived
        // together. Empty for every other kind of doc — a nested child's fields
        // are single-valued, and a flat text doc has no lists at all — so only
        // the case that needs the picture gets one.
        valueBags: multiValuedFields(d.fields),
        deleted: !!d.deleted,
        purged: !!d.purged,
      })),
  }
}

// ---------------------------------------------------------------------------
// Term statistics — what a scorer needs before it reads a single posting list.
//
// This is the other half of what a segment stores. The rows above say WHICH docs
// hold a term; these say HOW MANY do, which is the number BM25's idf is built
// from. Lucene keeps it in the term's metadata in `.tim` (see src/blocktree.js),
// precisely so a scorer can read it without walking `.doc`.
//
// Two things here are load-bearing and easy to get wrong:
//
//   1. THE SUM ACROSS SEGMENTS IS THE WHOLE POINT. A shard is several segments,
//      each with its own dictionary and its own docFreq for a term. Lucene's
//      TermStates.build() seeks the term in every segment, adds the frequencies
//      up, and the BM25 weight — the idf — is then computed ONCE for the shard
//      and handed to each segment's scorer. There is no such thing as a
//      per-segment idf, and computing one would rank the same document
//      differently depending on which segment it happened to land in.
//
//   2. THE STATISTICS INCLUDE DELETED DOCUMENTS. They come from the term
//      dictionary, and a delete does not touch it — the entries sit there until
//      a merge rewrites the segment (which is why the close-up draws them struck
//      through rather than gone). So `includePurged` is on here, and the visible
//      consequence is real Elasticsearch behaviour: deleting a document does not
//      move anybody's score until you merge.
// ---------------------------------------------------------------------------

// One Lucene doc's field length: how many tokens it holds, across every field.
// The number BM25 divides by. Lucene stores it as a lossily-encoded byte (the
// norm); at this scale the encoding would be exact, so it is kept as the count.
export const docFieldLen = (doc) =>
  Object.values(doc?.tokens ?? {}).reduce((n, terms) => n + terms.length, 0)

const emptyStats = () => ({ docCount: 0, sumTotalTermFreq: 0, byTerm: new Map() })

// avgFieldLen is derived rather than stored, exactly as Lucene derives it from
// sumTotalTermFreq / docCount — so a merge of two stats can just add the two
// totals and let the average fall out.
const withAverage = (s) => ({
  ...s,
  avgFieldLen: s.docCount ? s.sumTotalTermFreq / s.docCount : 0,
})

// What ONE segment's term metadata says. Deleted-but-unmerged docs count, per (2).
export function segmentStats(seg, docs) {
  const s = emptyStats()
  for (const id of seg.docIds) {
    const doc = docs[id]
    if (!doc) continue
    s.docCount += 1
    s.sumTotalTermFreq += docFieldLen(doc)
    const seen = new Set()
    for (const terms of Object.values(doc.tokens ?? {}))
      for (const term of terms) {
        if (!s.byTerm.has(term)) s.byTerm.set(term, { docFreq: 0, totalTermFreq: 0 })
        const e = s.byTerm.get(term)
        e.totalTermFreq += 1
        // docFreq counts DOCUMENTS, not occurrences — once per doc however many
        // times the term appears in it.
        if (!seen.has(term)) {
          e.docFreq += 1
          seen.add(term)
        }
      }
  }
  return withAverage(s)
}

// Add several stats together. ONE function for both roll-ups that exist: the
// per-segment stats a shard sums (query_then_fetch), and the per-shard stats the
// coordinator sums (dfs_query_then_fetch). Keeping them on one path is what
// stops the two modes from becoming two different scorers.
export function mergeStats(list) {
  const out = emptyStats()
  for (const s of list) {
    out.docCount += s.docCount
    out.sumTotalTermFreq += s.sumTotalTermFreq
    for (const [term, e] of s.byTerm) {
      if (!out.byTerm.has(term)) out.byTerm.set(term, { docFreq: 0, totalTermFreq: 0 })
      const o = out.byTerm.get(term)
      o.docFreq += e.docFreq
      o.totalTermFreq += e.totalTermFreq
    }
  }
  return withAverage(out)
}

// A shard's statistics: every searchable segment's, summed — plus the per-segment
// rows themselves, because the close-up's job is to SHOW the summing.
export function shardStats(shard, docs) {
  const segments = shard.segments
    .filter((seg) => seg.searchable)
    .map((seg) => ({ id: seg.id, ...segmentStats(seg, docs) }))
  return { ...mergeStats(segments), segments }
}

// The document frequency a scorer should use for `term`, or 0 when the shard has
// never seen it. Zero means the term contributes nothing here — NOT an infinitely
// rare term, which is what feeding 0 to idf() would imply.
export const docFreqOf = (stats, term) => stats?.byTerm.get(term)?.docFreq ?? 0
