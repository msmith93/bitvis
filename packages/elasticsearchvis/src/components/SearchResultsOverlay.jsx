import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { MAX_FETCH_WINNERS } from '../constants'

// What the client actually gets back once a search op has run its scatter-gather
// to completion: the true hit count plus the top MAX_FETCH_WINNERS ranked
// results (the only ones the fetch phase pulled full _source for), each row
// expandable to the document's indexed fields. Built from the SAME `search`
// (extra.search) the results panel already renders, so this can never disagree
// with what the stage just showed happening.
//
// It is deliberately NOT the verbatim Elasticsearch response JSON — the lesson
// here is "a ranked list of hits with a total", not the envelope shape.
export default function SearchResultsOverlay({ open, query, search, docs, onClose }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const merged = open && search ? search.merged : null
  // The fetch phase only pulled full _source for the top winners of the merged
  // ranking (MAX_FETCH_WINNERS), so those are the only hits the client actually
  // gets back — the summary still reports the true total that matched.
  const hits = merged ? merged.slice(0, MAX_FETCH_WINNERS) : null
  const total = merged ? merged.length : 0

  return (
    <AnimatePresence>
      {hits && (
        <>
          <motion.div
            className="index-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            onClick={onClose}
          />
          <div className="index-overlay-root">
            <motion.div
              className="index-card results-card"
              data-tour="results-card"
              initial={{ scale: 0.92, opacity: 0, y: 8 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ type: 'spring', stiffness: 240, damping: 26 }}
            >
              <div className="docs-head">
                <p className="section-title">Response returned to the client</p>
                <button className="si-close" onClick={onClose} title="Close">
                  ✕
                </button>
              </div>

              <div className="results-summary">
                <span className="results-total">{total}</span>
                <span>{total === 1 ? 'hit' : 'hits'} for “{query}”</span>
                {total > hits.length && (
                  <span className="routing-tag">showing top {hits.length}</span>
                )}
                {search.routing && (
                  <span className="routing-tag">
                    routing <b>{search.routing}</b> → shard {search.routedShard}
                  </span>
                )}
              </div>

              <div className="results-scroll">
                {hits.length === 0 ? (
                  <div className="results-empty">No documents matched.</div>
                ) : (
                  <ol className="results-list">
                    {hits.map((h, i) => (
                      <ResultRow
                        key={h.docId}
                        rank={i + 1}
                        hit={h}
                        doc={docs[h.docId]}
                        docs={docs}
                      />
                    ))}
                  </ol>
                )}
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  )
}

// A nested block's sub-objects, grouped by their `nested` path and each spelled
// back out as the { field: value } record it was indexed from. The app has no
// separate `_source`, but under `nested` mapping each sub-object IS its own
// Lucene doc (a child of this block), so the paired form can be reconstructed
// from those children — and that pairing surviving to read time is the whole
// point of nested mapping. Empty for a flat or `object`-mapped document, whose
// sub-objects were flattened into multi-valued fields on the root instead.
function childBlocks(root, docs) {
  const ord = (d) => Number(d.id.split('#').pop())
  const kids = Object.values(docs || {})
    .filter((d) => d?.kind === 'child' && d.root === root.id)
    .sort((a, b) => ord(a) - ord(b))
  const byPath = new Map()
  for (const kid of kids) {
    const entries = Object.entries(kid.fields).map(([k, v]) => [
      k.slice(kid.path.length + 1),
      v,
    ])
    byPath.set(kid.path, [...(byPath.get(kid.path) || []), entries])
  }
  return [...byPath].map(([path, items]) => ({ path, items }))
}

// One hit: a collapsed row (rank, id, shard, score) that expands to the
// document's indexed fields. Under `object` mapping the sub-objects were
// flattened into multi-valued fields on the root, so a field like
// `variants.color` simply shows all its values with the pairing gone — the
// nested lesson's cost made visible at read time. Under `nested` mapping the
// sub-objects come back paired, reconstructed from the block's child Lucene
// docs (see childBlocks).
function ResultRow({ rank, hit, doc, docs }) {
  const [open, setOpen] = useState(false)
  const fields = doc?.fields ? Object.entries(doc.fields) : []
  const nested = doc ? childBlocks(doc, docs) : []

  return (
    <li className="result-item">
      <button
        type="button"
        className="result-row"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="json-caret">{open ? '▾' : '▸'}</span>
        <span className="result-rank">{rank}</span>
        <span className="doc-chip" style={{ background: doc?.color || '#888' }}>
          {hit.docId}
        </span>
        {doc?.label && <span className="result-label">{doc.label}</span>}
        <span className="result-meta">
          shard {hit.shard} · score {hit.score}
        </span>
      </button>
      {open && (
        <div className="result-source">
          {fields.length === 0 && nested.length === 0 ? (
            <div className="json-row empty">(no indexed fields)</div>
          ) : (
            <>
              {fields.map(([k, v]) => (
                <div className="source-field" key={k}>
                  <span className="source-key">{k}</span>
                  <span className="source-val">
                    {Array.isArray(v) ? v.join(', ') : String(v)}
                  </span>
                </div>
              ))}
              {nested.map(({ path, items }) => (
                <div className="source-nested" key={path}>
                  <span className="source-key">{path}</span>
                  <ol className="source-nested-list">
                    {items.map((entries, i) => (
                      <li key={i}>
                        {entries.map(([k, v]) => (
                          <span className="source-subfield" key={k}>
                            <span className="source-subkey">{k}</span>
                            <span className="source-val">{String(v)}</span>
                          </span>
                        ))}
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </li>
  )
}
