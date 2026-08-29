import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

// What the client actually gets back once a search op has run its scatter-
// gather to completion — shown as an inspectable JSON tree, the read path's
// counterpart to the index form's "writes N Lucene docs" preview. Built from
// the SAME `search` (extra.search) the results panel already renders, so this
// can never disagree with what the stage just showed happening.
function buildResponse(query, search, docs) {
  const shardsQueried = Object.keys(search.serving)
    .map(Number)
    .sort((a, b) => a - b)
  return {
    query,
    routing: search.routing || null,
    shards: { queried: shardsQueried, skipped: search.skipped },
    hits: {
      total: search.merged.length,
      hits: search.merged.map((h) => ({
        _id: h.docId,
        _score: h.score,
        _shard: h.shard,
        // The indexed fields, not the original request body — this app never
        // models a separate `_source` (see src/mapping.js), so what a fetch
        // hands back is exactly what was analyzed. Under `object` mapping a
        // variant's fields are already flattened in here, which is the same
        // fact the nested lesson prices at index time.
        _source: docs[h.docId]?.fields ?? null,
      })),
    },
  }
}

export default function SearchResultsOverlay({ open, query, search, docs, onClose }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const response = open && search ? buildResponse(query, search, docs) : null

  return (
    <AnimatePresence>
      {response && (
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
              <div className="results-scroll">
                <JsonNode value={response} />
              </div>
              <p className="overlay-hint">
                The JSON the coordinator hands back: hit ids and scores with the
                shard each came from, plus every matching document's indexed
                fields. Click a bracket to collapse or expand that section.
              </p>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  )
}

// A minimal, dependency-free JSON tree: every object/array is a node whose
// brace can be toggled, collapsing to a one-line summary. Expanded by default
// — this dialog exists to show the full response, not to make you go dig for
// it — so collapsing is for focusing on one section, not for finding one.
function JsonNode({ name, value }) {
  const isContainer = value !== null && typeof value === 'object'
  const [open, setOpen] = useState(true)

  if (!isContainer) {
    return (
      <div className="json-row">
        {name != null && <span className="json-key">{name}: </span>}
        <JsonScalar value={value} />
      </div>
    )
  }

  const isArray = Array.isArray(value)
  const entries = isArray ? value.map((v, i) => [i, v]) : Object.entries(value)
  const [openBrace, closeBrace] = isArray ? ['[', ']'] : ['{', '}']

  return (
    <div className="json-node">
      <button type="button" className="json-toggle" onClick={() => setOpen((o) => !o)}>
        <span className="json-caret">{open ? '▾' : '▸'}</span>
        {name != null && <span className="json-key">{name}: </span>}
        <span className="json-bracket">{openBrace}</span>
        {!open && (
          <span className="json-summary">
            {entries.length} {isArray ? (entries.length === 1 ? 'item' : 'items') : entries.length === 1 ? 'key' : 'keys'}
          </span>
        )}
        {!open && <span className="json-bracket">{closeBrace}</span>}
      </button>
      {open && (
        <div className="json-children">
          {entries.length === 0 && <div className="json-row empty">(empty)</div>}
          {entries.map(([k, v]) => (
            <JsonNode key={k} name={isArray ? null : k} value={v} />
          ))}
          <div className="json-bracket json-close">{closeBrace}</div>
        </div>
      )}
    </div>
  )
}

function JsonScalar({ value }) {
  if (value === null) return <span className="json-null">null</span>
  if (typeof value === 'string') return <span className="json-string">"{value}"</span>
  if (typeof value === 'number') return <span className="json-number">{value}</span>
  if (typeof value === 'boolean') return <span className="json-bool">{String(value)}</span>
  return <span className="json-value">{String(value)}</span>
}
