import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import Stepper from '../components/Stepper'

// Generic zoom-in overlay: every close-up (quorum math, ring walk, Merkle
// trees, …) is a { title, sub, steps, Stage } ctx built by a module in this
// folder; this shell contributes the backdrop, the explain box, the
// mini-stepper with its auto-play clock, and the entrance spring out of the
// element the user clicked. Deliberately NO AnimatePresence exit: stages use
// framer `layout` chips, and an animated exit around relayouted chips can
// deadlock removal (see opensearchvis' CoordinatorInspector) — closing
// unmounts instantly instead.
const DWELL_MS = 2600

export default function CloseUp({ ctx, onClose }) {
  if (!ctx) return null
  return <Panel key={ctx.key} ctx={ctx} onClose={onClose} />
}

function Panel({ ctx, onClose }) {
  const { title, sub, steps, Stage, source } = ctx
  const last = steps.length - 1
  const [step, setStep] = useState(0)
  const [playing, setPlaying] = useState(true)

  // Auto-play clock.
  useEffect(() => {
    if (!playing) return
    if (step >= last) {
      setPlaying(false)
      return
    }
    const id = setTimeout(() => setStep((s) => Math.min(last, s + 1)), DWELL_MS)
    return () => clearTimeout(id)
  }, [playing, step, last])

  const go = (d) => {
    setPlaying(false)
    setStep((s) => Math.max(0, Math.min(last, s + d)))
  }

  // Spring out of the clicked element (measured on first render, while the
  // page is at rest behind the opening overlay).
  let initial = { opacity: 0, scale: 0.3 }
  const el = source ? document.querySelector(source) : null
  if (el) {
    const r = el.getBoundingClientRect()
    initial = {
      opacity: 0,
      scale: 0.3,
      x: r.left + r.width / 2 - window.innerWidth / 2,
      y: r.top + r.height / 2 - window.innerHeight / 2,
    }
  }

  const current = steps[step]
  return (
    <motion.div
      className="inspector-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      onClick={onClose}
    >
      <motion.div
        className="closeup-card"
        initial={initial}
        animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
        transition={{ type: 'spring', stiffness: 260, damping: 26 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="closeup-head">
          <h3>{title}</h3>
          <button className="btn mini" onClick={onClose}>
            ✕ close
          </button>
        </div>

        <div className="closeup-explain">
          <h4>{current.title}</h4>
          <p>{current.blurb}</p>
        </div>

        <div className="closeup-scroll">
          <Stage step={step} />
        </div>

        <div className="closeup-stepper">
          <Stepper
            steps={steps}
            step={step}
            opLabel={sub}
            playing={playing}
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
