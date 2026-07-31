import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import Stepper from '../components/Stepper'
import { rectCenter, selectorRect } from '../components/tokenFlight'
import { INSPECTOR_DWELL_MS } from '../timing'

// The generic zoom-in overlay. Every close-up — a shard's local search, the
// coordinator's merge, a segment's on-disk term dictionary — is a
// `{ key, title, sub, steps, Stage, stageProps }` ctx built by a module in
// ./stages and dispatched by ./index.js. This shell contributes the backdrop,
// the head with its ✕, the explain box, the mini-stepper with its auto-play
// clock, and the entrance spring out of the element the user clicked.
//
// Close-ups NEST: the stack is rendered bottom-to-top, each in its own
// backdrop, so a zoom opened from inside a zoom springs out of its parent and
// closing it returns the parent to the exact step it was left on. Only the top
// of the stack is `active` — it alone runs an auto-play clock, and stages read
// `active` to park their own timers (the dictionary probe replay) while a child
// is covering them.
//
// Deliberately NO AnimatePresence exit: stages use framer `layout` chips, and
// an animated exit around relayouted chips can deadlock removal, leaving an
// invisible backdrop that swallows every click (this app hit exactly that in
// the old CoordinatorInspector). Closing unmounts instantly instead; App's
// `.layout` zoom-back covers the transition.
export default function CloseUp({ stack, onPop, openCloseUp, highlightClose }) {
  if (!stack?.length) return null
  return stack.map((ctx, i) => (
    <Panel
      key={ctx.key}
      ctx={ctx}
      depth={i}
      active={i === stack.length - 1}
      openCloseUp={openCloseUp}
      // Only the root panel gets the tour's "click ✕ to exit" nudge — a nested
      // zoom is off-script and closing it doesn't leave the close-up.
      highlightClose={highlightClose && i === 0}
      onClose={() => onPop(i)}
    />
  ))
}

function Panel({ ctx, depth, active, openCloseUp, highlightClose, onClose }) {
  const { title, sub, steps, Stage, stageProps, source, className, dwell } = ctx
  const last = steps.length - 1
  const [step, setStep] = useState(0)
  const [playing, setPlaying] = useState(true)

  // Auto-play clock. `dwell` is a per-step budget (a stage with flights or a
  // probe replay to fit needs more than the flat default); it is excluded from
  // the deps because build() hands over a fresh closure on every re-derive.
  useEffect(() => {
    if (!playing || !active) return
    if (step >= last) {
      setPlaying(false)
      return
    }
    const ms = dwell?.(step) ?? INSPECTOR_DWELL_MS
    const id = setTimeout(() => setStep((s) => Math.min(last, s + 1)), ms)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, active, step, last])

  // Spring out of the clicked element, measured once at mount while the page
  // (or the parent panel) is still at rest behind the opening overlay.
  const [initial] = useState(() => {
    const c = rectCenter(selectorRect(source))
    return c
      ? {
          opacity: 0,
          scale: 0.25,
          x: c.x - window.innerWidth / 2,
          y: c.y - window.innerHeight / 2,
        }
      : { opacity: 0, scale: 0.25 }
  })

  const go = (delta) => {
    setPlaying(false)
    setStep((s) => Math.max(0, Math.min(last, s + delta)))
  }

  const current = steps[step]

  return (
    <motion.div
      className="shard-inspector-backdrop"
      // Stride of 1 so even a deeply nested stack stays under the walkthrough's
      // z-index 70 — the tour has to be able to spotlight controls inside a panel.
      style={{ zIndex: 60 + depth }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      onClick={onClose}
    >
      <motion.div
        className={'shard-inspector' + (className ? ' ' + className : '')}
        initial={initial}
        animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
        transition={{ type: 'spring', stiffness: 260, damping: 26 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="si-head">
          <div className="si-title">{title}</div>
          <div className="si-close-wrap">
            {highlightClose && step >= last && (
              <span className="si-close-hint">Done exploring? Click ✕ to exit →</span>
            )}
            <button
              className={'si-close' + (highlightClose ? ' tour-pulse' : '')}
              onClick={onClose}
              title="Close"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="si-explain">
          <h4>{current.title}</h4>
          <p>{current.blurb}</p>
        </div>

        {/* The stage returns a FRAGMENT, so its pinned strips (.si-querybox) and
            its scroller (.si-scroll) are direct flex children of
            .shard-inspector — which is what the stylesheet's `> .si-*` rules
            expect. Don't wrap it in a div. */}
        <Stage step={step} active={active} openCloseUp={openCloseUp} {...stageProps} />

        <div className="si-stepper">
          <Stepper
            steps={steps}
            step={step}
            opLabel={sub}
            playing={playing && active}
            onPrev={() => go(-1)}
            onNext={() => go(1)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
          />
        </div>
      </motion.div>
    </motion.div>
  )
}
