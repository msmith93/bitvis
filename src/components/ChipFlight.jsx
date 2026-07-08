import { motion, AnimatePresence } from 'framer-motion'
import { FLIGHT_STAGGER_MS, FLIGHT_CHIP_TRAVEL_S } from '../timing'

// Centre point of a rect-like object in viewport coordinates.
export function rectCenter(rect) {
  if (!rect) return null
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

// Look up a live DOM node's viewport rect by selector (e.g. an actor box
// tagged with data-fly). Returns null if it isn't mounted.
export function selectorRect(selector) {
  const el = document.querySelector(selector)
  return el ? el.getBoundingClientRect() : null
}

// A fixed, click-through layer that flies a batch of chips from a source
// element to a target element with a small stagger. Purely decorative: the
// derived cluster is the source of truth, so no onComplete state — the step
// budget (flightAwareDuration) reserves time for the flight instead.
// Ported from opensearchvis's FlyingTokens.
export default function ChipFlight({ tokens, fromSel, toSel, spread = 16 }) {
  const start = rectCenter(selectorRect(fromSel))
  const end = rectCenter(selectorRect(toSel))
  if (!start || !end || tokens.length === 0) return null

  return (
    <div className="chip-flight-layer">
      <AnimatePresence>
        {tokens.map((t, i) => {
          const jx = (Math.random() - 0.5) * spread
          const jy = (Math.random() - 0.5) * spread
          return (
            <motion.span
              key={t.id}
              className="flying-chip"
              style={t.color ? { background: t.color } : undefined}
              initial={{ x: start.x + jx, y: start.y + jy, opacity: 0, scale: 0.7 }}
              animate={{
                x: [start.x + jx, end.x + jx],
                y: [start.y + jy, end.y + jy],
                opacity: [0, 1, 1, 0],
                scale: [0.7, 1, 1, 0.6],
              }}
              transition={{
                duration: FLIGHT_CHIP_TRAVEL_S,
                delay: i * (FLIGHT_STAGGER_MS / 1000),
                ease: 'easeInOut',
                times: [0, 0.15, 0.8, 1],
              }}
            >
              {t.term}
            </motion.span>
          )
        })}
      </AnimatePresence>
    </div>
  )
}
