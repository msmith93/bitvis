import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { SCENARIOS } from '../scenarios'

// Top-right menu that starts (or restarts) a guided scenario. Picking the one
// that is already running replays it from step 1 — that is the point of having
// the menu at all, since the intro tour used to be a one-shot on first load.
export default function ScenarioPicker({ activeId, running, onStart }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="scenario-picker" ref={ref}>
      <button
        className="btn scenario-trigger"
        data-tour="scenarios"
        onClick={() => setOpen((o) => !o)}
      >
        Scenarios <span className="caret">▾</span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            className="scenario-menu"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.15 }}
          >
            {SCENARIOS.map((s) => {
              const isActive = running && s.id === activeId
              return (
                <button
                  key={s.id}
                  className={'scenario-item' + (isActive ? ' active' : '')}
                  onClick={() => {
                    setOpen(false)
                    onStart(s.id)
                  }}
                >
                  <span className="scenario-item-label">
                    {s.label}
                    {isActive && <span className="scenario-running">running</span>}
                  </span>
                  <span className="scenario-item-blurb">{s.blurb}</span>
                </button>
              )
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
