// Pure derivations of what segments/shards physically store, for the UI's
// inverted-index views. No model change ever happens here.

import { docRootId, isRootDoc } from './cluster'

// Sort a term->docIds Map into the [{term, docIds}] rows the UI renders.
const indexRows = (map) =>
  [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([term, ids]) => ({ term, docIds: [...ids] }))

// Build ONE segment's inverted index (term -> Lucene doc ids). A tombstoned doc
// stays in the index until a refresh applies the delete (purged); only then does
// it leave.
//
// The postings address LUCENE docs, so a nested child appears here in its own
// right -- that is the whole reason a nested query needs a join to get back to
// the document you asked for. The field set comes from the doc rather than a
// hardcoded pair, so a child's "variants.color" indexes like any other field.
export function segmentInvertedIndex(seg, docs) {
  const map = new Map()
  for (const id of seg.docIds) {
    const doc = docs[id]
    if (!doc || doc.purged) continue
    for (const terms of Object.values(doc.tokens))
      for (const term of terms) {
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
// Pure derivation — no model change. Includes purged docs in `docs` so the bitset
// can show them, even though segmentInvertedIndex omits them from `terms`.
//
// Each doc carries its ORDINAL (its index in seg.docIds -- that is what a Lucene
// doc id is) plus whether it is a block root.
export function segmentAnatomy(seg, docs) {
  return {
    id: seg.id,
    terms: segmentInvertedIndex(seg, docs),
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
