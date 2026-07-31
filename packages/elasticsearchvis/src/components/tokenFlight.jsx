import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { flightMs, FLIGHT_STAGGER_MS, FLIGHT_TOKEN_TRAVEL_S } from '../timing'

// Centre point of a rect-like object ({left, top, width, height}) in viewport
// coordinates. Returns null for a missing rect so callers can bail safely.
export function rectCenter(rect) {
  if (!rect) return null
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

// Look up a live DOM node's viewport rect by selector (e.g. a shard card tagged
// with data-shard-target). Returns null if it isn't mounted.
export function selectorRect(selector) {
  const el = document.querySelector(selector)
  return el ? el.getBoundingClientRect() : null
}

// A fixed, click-through layer that flies a batch of token chips from a source
// point to a target point with a small stagger, then calls onComplete. Shared by
// the index overlay (form → shard buffer) and refresh (segment → inverted index).
export default function FlyingTokens({ tokens, from, to, onComplete, spread = 18, variant }) {
  const start = rectCenter(from)
  const end = rectCenter(to)

  useEffect(() => {
    if (!start || !end || tokens.length === 0) {
      onComplete?.()
      return
    }
    const id = setTimeout(() => onComplete?.(), flightMs(tokens.length))
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!start || !end || tokens.length === 0) return null

  return (
    <div className="token-flight-layer">
      <AnimatePresence>
        {tokens.map((t, i) => {
          const jx = (Math.random() - 0.5) * spread
          const jy = (Math.random() - 0.5) * spread
          return (
            <motion.span
              key={t.id}
              className={'flying-token' + (variant ? ' flying-token--' + variant : '')}
              style={{ background: t.color || 'var(--accent)' }}
              initial={{ x: start.x + jx, y: start.y + jy, opacity: 0, scale: 0.7 }}
              animate={{
                x: [start.x + jx, end.x + jx],
                y: [start.y + jy, end.y + jy],
                opacity: [0, 1, 1, 0],
                scale: [0.7, 1, 1, 0.6],
              }}
              transition={{
                duration: FLIGHT_TOKEN_TRAVEL_S,
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

// Convenience hook: returns a [rects, capture] pair where capture(name, rect)
// stores a rect under a name. Kept tiny; most callers use selectorRect instead.
export function useRectStore() {
  const [rects, setRects] = useState({})
  const capture = (name, rect) => setRects((r) => ({ ...r, [name]: rect }))
  return [rects, capture]
}
