// What a segment's STORED FIELDS are: the on-disk `.fdt` file, addressed by
// Lucene ordinal, holding the stored fields of every Lucene doc — which in
// Elasticsearch means `_id` and `_source` (the original JSON, verbatim), because
// the ordinary mapped fields are NOT stored: they are indexed, and `_source` is
// what gets returned. `.fdx` is the small index beside it that says which
// compressed CHUNK of `.fdt` holds a given ordinal. This is the model behind the
// stored-fields tile of the segment close-up, and the fetch-phase close-up's
// resolution of a hit to the segment and ordinal that hold it.
//
// The one fact this file exists to place correctly: stored fields are read in
// the FETCH phase, not the query phase. A shard answers a query with ordinals
// and scores — it never opens `.fdt` to do so — and only the winners of the
// coordinator's cut ever come back to be fetched. So the query-phase tour marks
// this tile "later", and the fetch step opens it.
//
// A block ROOT carries `_source` (buildBlock stashes it — see src/mapping.js).
// A nested CHILD carries nothing here: Elasticsearch indexes the parent's `_id`
// on it so a delete removes the whole block, but does not store it, and there
// is no `_source` for a child at all — the document's `_source` lives on its
// root and is returned from there.
//
// Flagged simplification (SPEC.md): chunks are toy-scaled — FDT_CHUNK_MAX docs
// per chunk instead of Lucene's byte-sized chunks — so a chunk boundary can be
// seen. Reading one document means locating its chunk through `.fdx` and
// decompressing that chunk, which is the real cost shape.

import { docRootId, isRootDoc } from './cluster'

export const FDT_CHUNK_MAX = 4
const FDT_BASE = 0x1000
const FDT_STRIDE = 0x100
export const hexFp = (fp) => '0x' + fp.toString(16).toUpperCase().padStart(4, '0')

// Returns { rows, chunks, maxDoc }:
//   rows    one per Lucene doc, in ORDINAL order: { ord, id, root, isRoot,
//           source (root only, else null), chunk (index into chunks), purged }
//   chunks  [{ index, fp, first, last, ords }] — the `.fdx` index is exactly
//           this list: first ordinal -> file pointer of the chunk
export function buildStoredFields(seg, docs) {
  const rows = seg.docIds.map((id, ord) => {
    const d = docs[id]
    const root = isRootDoc(d)
    return {
      ord,
      id,
      root: docRootId(d),
      isRoot: root,
      source: root ? (d?.source ?? d?.fields ?? null) : null,
      chunk: Math.floor(ord / FDT_CHUNK_MAX),
      purged: !!d?.purged,
      deleted: !!d?.deleted,
    }
  })
  const chunks = []
  for (let i = 0; i * FDT_CHUNK_MAX < rows.length; i++) {
    const ords = rows.slice(i * FDT_CHUNK_MAX, (i + 1) * FDT_CHUNK_MAX).map((r) => r.ord)
    chunks.push({ index: i, fp: FDT_BASE + i * FDT_STRIDE, first: ords[0], last: ords[ords.length - 1], ords })
  }
  return { rows, chunks, maxDoc: rows.length }
}

// The fetch of one ordinal: the `.fdx` lookup that names the chunk, then the
// row inside it. Null when the ordinal is not in this segment.
export function locateOrdinal(sf, ord) {
  const row = sf.rows[ord]
  if (!row) return null
  return { row, chunk: sf.chunks[row.chunk] }
}

// Which segment of a shard holds a Lucene doc, and at which ordinal. This is
// what a shard's reader does with a hit's doc id at fetch time before it can
// open anything: the composite reader maps the id to a leaf (a segment) and a
// segment-local ordinal. Null if no searchable segment holds it.
export function locateInShard(shard, id) {
  for (const seg of shard.segments) {
    if (!seg.searchable) continue
    const ord = seg.docIds.indexOf(id)
    if (ord >= 0) return { seg, ord }
  }
  return null
}
