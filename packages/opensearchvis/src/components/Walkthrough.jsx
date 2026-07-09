import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { selectorRect } from './tokenFlight'

const PAD = 6 // breathing room between the target and the spotlight hole
const TIP_W = 280 // fixed tooltip width keeps viewport clamping simple
const TIP_GAP = 14 // gap between the hole and the tooltip

function toPlain(r) {
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}

function moved(a, b) {
  if (!a || !b) return a !== b
  return (
    Math.abs(a.left - b.left) > 1 ||
    Math.abs(a.top - b.top) > 1 ||
    Math.abs(a.width - b.width) > 1 ||
    Math.abs(a.height - b.height) > 1
  )
}

// Track a target's viewport rect with a rAF loop while a spotlight step is
// visible. This transparently follows window resizes, framer-motion springs
// settling, and targets that mount late — a null rect means "not there yet",
// and the tour keeps waiting.
function useTargetRect(selector, enabled) {
  const [rect, setRect] = useState(null)
  useEffect(() => {
    if (!enabled || !selector) {
      setRect(null)
      return
    }
    let raf
    const tick = () => {
      const r = selectorRect(selector)
      setRect((prev) => (moved(prev, r) ? (r ? toPlain(r) : null) : prev))
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [selector, enabled])
  return rect
}

function tipPos(rect, placement) {
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (placement === 'top') {
    // Anchored by `bottom` so the tooltip's own height doesn't matter, centered
    // on the target (used for the full-width footer stepper).
    return {
      left: Math.max(
        12,
        Math.min(rect.left + rect.width / 2 - TIP_W / 2, vw - TIP_W - 12),
      ),
      bottom: vh - rect.top + PAD + TIP_GAP,
    }
  }
  let left
  let top
  if (placement === 'bottom') {
    left = rect.left
    top = rect.top + rect.height + PAD + TIP_GAP
  } else if (placement === 'left') {
    left = rect.left - PAD - TIP_GAP - TIP_W
    top = rect.top
  } else {
    // 'right' (default)
    left = rect.left + rect.width + PAD + TIP_GAP
    top = rect.top
  }
  return {
    left: Math.max(12, Math.min(left, vw - TIP_W - 12)),
    top: Math.max(12, Math.min(top, vh - 220)),
  }
}

// The tour's presentation layer: a centered card for target-less steps
// (welcome/finish), or a spotlight for targeted steps — four dim rectangles
// around the target swallow stray clicks while the hole between them lets the
// real control receive its click, plus an accent ring and an instruction
// tooltip. Sits at z-index 70: above the index overlay (50/51) and inspector
// (60), below the cookie banner (10000).
export default function Walkthrough({ tour, allowEscape = true }) {
  const { status, step, visible, stepIndex, stepCount, next, skip, finish } = tour
  const running = status === 'running'
  const spotlight = running && visible && step?.target ? step : null
  const rect = useTargetRect(spotlight?.target, !!spotlight)

  // Escape ends the tour — except while the shard inspector is open (the
  // inspector owns the key there; App passes allowEscape accordingly).
  useEffect(() => {
    if (!running) return
    const onKey = (e) => {
      if (e.key === 'Escape' && allowEscape) skip()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [running, allowEscape, skip])

  if (!running || !visible || !step) return null

  // ---- centered card (welcome / finish) ----
  if (!step.target) {
    const paras = Array.isArray(step.body) ? step.body : [step.body]
    const isLast = stepIndex === stepCount - 1
    return (
      <>
        <motion.div
          className="tour-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4 }}
        />
        <div className="tour-card-root">
          <motion.div
            className="tour-card"
            initial={{ scale: 0.92, opacity: 0, y: 8 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            transition={{ type: 'spring', stiffness: 240, damping: 26 }}
          >
            <h2>{step.title}</h2>
            {paras.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
            <div className="tour-card-actions">
              <button className="btn primary" onClick={isLast ? finish : next}>
                {step.cta}
              </button>
              {step.secondary && (
                <button className="tour-skip" onClick={skip}>
                  {step.secondary}
                </button>
              )}
            </div>
          </motion.div>
        </div>
      </>
    )
  }

  // ---- spotlight (targeted step) ----
  if (!rect) return null // target not mounted yet — keep waiting

  const hole = {
    left: rect.left - PAD,
    top: rect.top - PAD,
    right: rect.left + rect.width + PAD,
    bottom: rect.top + rect.height + PAD,
  }
  const tip = tipPos(rect, step.placement)

  return (
    <div className="tour-layer">
      <div
        className="tour-dim"
        style={{ left: 0, top: 0, right: 0, height: Math.max(0, hole.top) }}
      />
      <div className="tour-dim" style={{ left: 0, top: hole.bottom, right: 0, bottom: 0 }} />
      <div
        className="tour-dim"
        style={{
          left: 0,
          top: hole.top,
          width: Math.max(0, hole.left),
          height: hole.bottom - hole.top,
        }}
      />
      <div
        className="tour-dim"
        style={{ left: hole.right, top: hole.top, right: 0, height: hole.bottom - hole.top }}
      />
      <motion.div
        className="tour-ring"
        initial={false}
        animate={{
          x: hole.left,
          y: hole.top,
          width: rect.width + PAD * 2,
          height: rect.height + PAD * 2,
        }}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      />
      <motion.div
        key={step.id}
        className="tour-tip"
        style={tip}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
      >
        <h3>{step.title}</h3>
        <p>{step.body}</p>
        <div className="tour-tip-foot">
          <span className="tour-step-count">
            {stepIndex + 1} of {stepCount}
          </span>
          <span className="tour-tip-actions">
            {step.cta && (
              <button className="btn primary tour-cta" onClick={next}>
                {step.cta}
              </button>
            )}
            <button className="tour-skip" onClick={skip}>
              Skip tour
            </button>
          </span>
        </div>
      </motion.div>
    </div>
  )
}
