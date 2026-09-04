import { useEffect, useMemo, useState } from 'react'
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

// A fixed, click-through layer that flies a batch of chips from a source point
// to a target point with a small stagger, then calls onComplete. Shared by every
// hop this app draws: the indexing chain to the content nodes, the query out,
// the hits back, and the summary fill.
export default function FlyingTokens({
  tokens,
  from,
  to,
  onComplete,
  spread = 18,
  variant,
  delayMs = 0, // holds the whole batch off, so it can visibly follow another flight (a request, then its response)
}) {
  const start = rectCenter(from)
  const end = rectCenter(to)

  // Randomized ONCE per token and held stable across re-renders. This
  // component's parent (SearchFlight et al.) re-renders for reasons that have
  // nothing to do with this flight, and recomputing jx/jy inline on every
  // render fed Framer Motion a new `animate` target each time — which reads
  // as "retarget", so the chip kept restarting its move toward a slightly
  // different point instead of ever completing the trip. The longer a flight
  // waits before it starts (a delayed fetch-phase response, say), the more
  // renders it survives to be retargeted by, so this was invisible on short
  // flights and glaring on delayed ones — the chip would fade in and out
  // near its start point without visibly travelling anywhere.
  const jitter = useMemo(
    () =>
      tokens.map(() => ({
        jx: (Math.random() - 0.5) * spread,
        jy: (Math.random() - 0.5) * spread,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tokens],
  )

  useEffect(() => {
    if (!start || !end || tokens.length === 0) {
      onComplete?.()
      return
    }
    const id = setTimeout(() => onComplete?.(), delayMs + flightMs(tokens.length))
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!start || !end || tokens.length === 0) return null

  return (
    <div className="token-flight-layer">
      <AnimatePresence>
        {tokens.map((t, i) => {
          const { jx, jy } = jitter[i]
          return (
            <motion.span
              key={t.id}
              className={'flying-token' + (variant ? ' flying-token--' + variant : '')}
              style={variant === 'request' ? undefined : { background: t.color || 'var(--accent)' }}
              initial={{ x: start.x + jx, y: start.y + jy, opacity: 0, scale: 0.7 }}
              animate={{
                x: [start.x + jx, end.x + jx],
                y: [start.y + jy, end.y + jy],
                opacity: [0, 1, 1, 0],
                scale: [0.7, 1, 1, 0.6],
              }}
              transition={{
                duration: FLIGHT_TOKEN_TRAVEL_S,
                delay: delayMs / 1000 + i * (FLIGHT_STAGGER_MS / 1000),
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
