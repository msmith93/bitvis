import { useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

// The document list, on demand. It used to sit permanently in the left column,
// where a dozen sample docs pushed everything else off-screen; now it opens from
// the "Delete a document" button and scrolls inside its own card.
//
// Deleting still records a TOMBSTONE (the doc stays searchable until a refresh
// applies it, per the SPEC guardrail) — the copy in here says so, because that
// delay is the thing worth teaching.
export default function DeleteDocOverlay({ open, docs, onToggleDelete, onClose }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
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
              className="index-card docs-card"
              initial={{ scale: 0.92, opacity: 0, y: 8 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ type: 'spring', stiffness: 240, damping: 26 }}
            >
              <div className="docs-head">
                <p className="section-title">Documents in the cluster</p>
                <button className="si-close" onClick={onClose} title="Close">
                  ✕
                </button>
              </div>

              {docs.length === 0 ? (
                <div className="empty-note">
                  Nothing indexed yet — index a document or load a sample set.
                </div>
              ) : (
                <>
                  <div className="docs-scroll">
                    {docs.map((d) => (
                      <div
                        key={d.id}
                        className={'doc-row' + (d.deleted ? ' deleted' : '')}
                      >
                        <span className="dot" style={{ background: d.color }} />
                        <span className="doc-id">{d.id}</span>
                        <span className="doc-shard">
                          {d.deleted
                            ? d.purged
                              ? 'deleted'
                              : 'tombstoned · refresh to apply'
                            : d.routing
                            ? `${d.routing} → shard ${d.shard}`
                            : `→ shard ${d.shard}`}
                        </span>
                        <button className="mini" onClick={() => onToggleDelete(d.id)}>
                          {d.deleted ? 'undo' : 'delete'}
                        </button>
                      </div>
                    ))}
                  </div>
                  <p className="overlay-hint">
                    A delete only writes a tombstone: the document stays searchable
                    until the next <b>Refresh</b> applies it, and its space is
                    reclaimed at the next <b>Merge</b>.
                  </p>
                </>
              )}
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  )
}
