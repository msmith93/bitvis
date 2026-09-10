// What a term's POSTING LIST is: the on-disk `.doc` file, one list per term, of
// the Lucene documents that contain it — as segment-local ORDINALS, each with
// the term's frequency in that doc. This is the model behind the postings tile
// of the segment close-up.
//
// Deliberately the CONCEPT and not the encoding. A zoom that taught the `.doc`
// encoding (delta-coded ordinals, bit-packed blocks, a VInt tail, skip lists)
// existed and was removed — SPEC.md records why, and the reasons still hold:
// this dataset cannot demonstrate any of it, and none of it is what a reader
// needs in order to understand what search does with a posting list. What a
// reader DOES need is the hop itself: the term row in `.tim` carries a pointer
// into `.doc`; what sits there is numbers, not text; and those numbers are the
// row addresses the stored-fields file (`.fdt`) is indexed by. Three things
// this model exists to make visible:
//
//   1. a posting is an ORDINAL — `seg.docIds` is the segment's Lucene docs in
//      ordinal order, so the ordinal is the array index (see src/cluster.js);
//   2. a posting carries the term's FREQUENCY in that doc, which is what the
//      scorer reads — the same count `scoreDoc` in src/ops/search.js produces;
//   3. the text is never read here. `.doc` holds ordinals and frequencies and
//      nothing else (positions live in `.pos`, which this app does not model).
//
// Fake-but-stable file offsets, exactly like src/blocktree.js's block pointers,
// so the same term always shows the same `.doc @…` address wherever it appears.

const DOC_BASE = 0x800
export const hexFp = (fp) => '0x' + fp.toString(16).toUpperCase().padStart(3, '0')

// How often `term` occurs in one Lucene doc, across every field. The same
// counting rule as scoreDoc's per-term tally, so the two levels cannot drift.
export function termFreq(doc, term) {
  let n = 0
  for (const terms of Object.values(doc?.tokens ?? {})) for (const t of terms) if (t === term) n += 1
  return n
}

// rows: [{ term, docIds }] sorted by term — exactly what segmentInvertedIndex
// returns for `seg`. Returns { order, byTerm, total }:
//   order   the terms in dictionary order (the order the lists sit in the file)
//   byTerm  term -> { term, fp, docFreq, entries: [{ ord, id, freq }] }, entries
//           in ORDINAL order — which is the order a real posting list is stored
//           and read in (nextDoc() only ever moves forward)
//   total   the number of postings in the segment
export function buildPostings(seg, rows, docs) {
  const ordOf = new Map(seg.docIds.map((id, ord) => [id, ord]))
  const byTerm = new Map()
  const order = []
  let fp = DOC_BASE
  let total = 0
  for (const row of rows) {
    const entries = row.docIds
      .filter((id) => ordOf.has(id))
      .map((id) => ({ ord: ordOf.get(id), id, freq: termFreq(docs[id], row.term) }))
      .sort((a, b) => a.ord - b.ord)
    // docFreq is the list's length, but it is NOT stored in .doc — it is a
    // per-term statistic in the .tim term metadata (that is the whole point of
    // storing it: a scorer reads it without walking the list). Kept here as a
    // derived quantity the checks pin and the .tim tile renders.
    byTerm.set(row.term, { term: row.term, fp, docFreq: entries.length, entries })
    order.push(row.term)
    // Each posting is drawn as a (ordinal, freq) pair; four bytes apiece is a
    // plausible uncompressed cost and keeps the addresses readable.
    fp += Math.max(1, entries.length) * 4
    total += entries.length
  }
  return { order, byTerm, total }
}

// The replayable walk of one or more lists: the postings step reveals these in
// order, one entry per tick, and the reveal counter indexes into `order`.
// `terms` are the terms the query actually resolved to in this segment — one
// for an exact term, the whole expansion for a pattern — in dictionary order.
export function postingsWalk(postings, terms) {
  const walked = terms.filter((t) => postings.byTerm.has(t))
  const order = []
  for (const term of walked)
    for (const e of postings.byTerm.get(term).entries)
      order.push({ term, ...e, i: order.length })
  return { terms: walked, order, units: order.length }
}
