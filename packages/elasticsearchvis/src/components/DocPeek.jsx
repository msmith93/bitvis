import { motion, AnimatePresence } from 'framer-motion'
import { SourceField, sourceEntries } from './sourceView'

// The card that answers "which document IS this?" while the pointer rests on a
// doc chip. It shows `_source` — the original JSON — through the same renderer
// the search response uses, so the stage and the response can never describe the
// same document differently.
//
// It is a FIXED layer rather than a child of the chip: chips live inside
// `.mini-seg`, which framer gives a transform for its layout animation, and a
// transformed ancestor would become the containing block for anything fixed
// inside it. ClusterStage renders this at `.cluster`, which has none.
//
// `pointer-events: none` is deliberate and is the whole reason hover works here
// at all: the card can never steal the hover it was opened by, so there is no
// "keep it open while the pointer is over the card" state machine. The cost is
// that its text can't be selected — that was the accepted trade against a click
// popup, since `_source` never changes as the op steps and there is nothing to
// pin.

const PEEK_W = 280
const EDGE = 8 // keep the card this far from the viewport edge
const GAP = 10 // ...and this far from the chip it describes
const FLIP_BELOW_ABOVE_PX = 220 // less headroom than this and the card drops below

export default function DocPeek({ peek, docs }) {
  const d = peek ? docs[peek.id] : null
  // A child Lucene doc has no `_source` of its own — only the block ROOT carries
  // one, and reconstructing a sub-object from its child is exactly what the
  // model forbids. So a child peek shows its root's source and says which
  // ordinal within the block the pointer is actually on.
  const root = d ? (d.kind === 'child' ? docs[d.root] : d) : null
  const entries = root ? sourceEntries(root) : []

  const rect = peek?.rect
  const above = rect ? rect.top > FLIP_BELOW_ABOVE_PX : true
  // Centre on the chip, then clamp so a chip near either edge still gets a card
  // that is fully on screen.
  const left = rect
    ? Math.min(
        Math.max(EDGE, rect.left + rect.width / 2 - PEEK_W / 2),
        window.innerWidth - PEEK_W - EDGE,
      )
    : 0
  // Anchoring the ABOVE case by `bottom` means the card never needs to know its
  // own height to sit on top of the chip.
  const vertical = rect
    ? above
      ? { bottom: window.innerHeight - rect.top + GAP }
      : { top: rect.bottom + GAP }
    : {}

  return (
    <AnimatePresence>
      {peek && root && (
        <motion.div
          // ONE key for every document, deliberately: moving the pointer from
          // one chip to the next keeps this node and just repositions it, the
          // way a tooltip behaves. Keying by doc id instead cross-faded two
          // cards over each other on every chip-to-chip move.
          key="peek"
          className="doc-peek"
          style={{ left, width: PEEK_W, ...vertical }}
          initial={{ opacity: 0, y: above ? 4 : -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
        >
          <div className="doc-peek-head">
            <span className="doc-chip" style={{ background: root.color || '#888' }}>
              {root.id}
            </span>
            <span className="doc-peek-title">_source</span>
          </div>
          {d.kind === 'child' && (
            <div className="doc-peek-note">
              hovering {d.path}[{peek.id.slice(peek.id.lastIndexOf('#') + 1)}] — one of{' '}
              {root.blockSize} Lucene docs in this block
            </div>
          )}
          <div className="doc-peek-body">
            {entries.length === 0 ? (
              <div className="json-row empty">(empty _source)</div>
            ) : (
              entries.map(([k, v]) => <SourceField key={k} name={k} value={v} />)
            )}
          </div>
          {root.deleted && (
            <div className="doc-peek-note warn">
              {root.purged
                ? 'deleted — a refresh has applied the tombstone; it is out of search'
                : 'deleted — tombstoned, but still searchable until the next refresh'}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
