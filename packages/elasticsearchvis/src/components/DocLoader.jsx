import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { DATASETS } from '../presets'

// The "Load docs" menu in the Documents column. There were two flat buttons
// here (sample / routed); they became one trigger plus a menu so that adding a
// dataset is an entry in DATASETS rather than another button in the column.
//
// The menu is absolutely positioned on purpose: the controls in this column
// must never shift each other (see the note in App.jsx), and an in-flow
// disclosure would push everything below it down by the height of the list.
//
// Both the trigger and the open menu carry `data-tour` hooks. A walkthrough
// spotlight cuts ONE hole in its dim layer and that layer swallows every click
// outside it, so a step that asks the user to pick a dataset points at the
// trigger and names the menu as its `targetExtra` — Walkthrough unions the two
// rects, and the menu items stay clickable while the menu is open.
// `required` is the dataset a running scenario step is asking for (its `dataset`
// field), or null when nothing is scripted. The spotlight's hole has to expose
// the whole menu for it to be usable at all, and a hole is one rectangle — it
// cannot exclude a middle item — so picking the WRONG dataset is prevented here
// instead: the wanted item pulses, every other one is disabled.
export default function DocLoader({ loaded, required = null, onLoad }) {
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
    <div className="doc-loader" ref={ref}>
      <button
        className="btn block doc-loader-trigger"
        data-tour="load-docs"
        onClick={() => setOpen((o) => !o)}
      >
        Load docs <span className="caret">▾</span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            className="doc-loader-menu"
            data-tour="load-docs-menu"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.15 }}
          >
            {DATASETS.map((d) => {
              const wanted = required === d.id
              return (
                <button
                  key={d.id}
                  className={
                    'doc-loader-item' +
                    (loaded === d.id ? ' active' : '') +
                    (wanted ? ' wanted' : '')
                  }
                  data-tour={`load-${d.id}`}
                  disabled={required != null && !wanted}
                  onClick={() => {
                    setOpen(false)
                    onLoad(d.id)
                  }}
                >
                  <span className="doc-loader-item-label">
                    {d.label}
                    {loaded === d.id && <span className="doc-loader-loaded">loaded</span>}
                  </span>
                  <span className="doc-loader-item-blurb">{d.blurb}</span>
                </button>
              )
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
