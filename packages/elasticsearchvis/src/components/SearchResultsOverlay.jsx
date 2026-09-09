import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { MAX_FETCH_WINNERS } from '../constants'
import { SourceField, sourceEntries } from './sourceView'

// What the client actually gets back once a search op has run its scatter-gather
// to completion: the true hit count plus the top MAX_FETCH_WINNERS ranked
// results (the only ones the fetch phase pulled full _source for), each row
// expandable to the document's `_source`. Built from the SAME `search`
// (extra.search) the results panel already renders, so this can never disagree
// with what the stage just showed happening.
//
// The row body is `_source` — the original JSON, returned verbatim and IDENTICAL
// under `object` and `nested` mapping (sub-objects paired either way). The
// flattening that `object` mapping does is invisible here on purpose: that is
// why an object-mapping false positive is so easy to miss. The flattened indexed
// form is shown one zoom down, in the shard close-up.
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
// document's `_source` — the original JSON, the same under either mapping. Falls
// back to the flattened indexed `fields` only for a doc built before blocks
// carried their source (none, in practice).
function ResultRow({ rank, hit, doc }) {
  const [open, setOpen] = useState(false)
  const entries = sourceEntries(doc)

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
          {entries.length === 0 ? (
            <div className="json-row empty">(empty _source)</div>
          ) : (
            entries.map(([k, v]) => <SourceField key={k} name={k} value={v} />)
          )}
        </div>
      )}
    </li>
  )
}
