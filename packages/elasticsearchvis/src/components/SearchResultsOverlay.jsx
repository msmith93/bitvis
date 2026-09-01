import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

// What the client actually gets back once a search op has run its scatter-gather
// to completion: the hit count and the ranked list of results, each row
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

  const hits = open && search ? search.merged : null

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
                <span className="results-total">{hits.length}</span>
                <span>{hits.length === 1 ? 'hit' : 'hits'} for “{query}”</span>
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

// One hit: a collapsed row (rank, id, shard, score) that expands to the
// document's indexed fields. The indexed form is all this app models — there is
// no separate `_source` (see src/mapping.js) — so a multi-valued field under
// `object` mapping simply shows all its values, which is the nested lesson's
// cost made visible at read time.
function ResultRow({ rank, hit, doc }) {
  const [open, setOpen] = useState(false)
  const fields = doc?.fields ? Object.entries(doc.fields) : []

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
          {fields.length === 0 ? (
            <div className="json-row empty">(no indexed fields)</div>
          ) : (
            fields.map(([k, v]) => (
              <div className="source-field" key={k}>
                <span className="source-key">{k}</span>
                <span className="source-val">
                  {Array.isArray(v) ? v.join(', ') : String(v)}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </li>
  )
}
