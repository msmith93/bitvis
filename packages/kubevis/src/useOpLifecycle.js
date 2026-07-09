import { useEffect, useMemo, useState } from 'react'
import { applyOp, deriveCluster, lastStep, opExtra, stepDuration } from './ops'

// The op lifecycle state machine: the committed cluster, the active op, the
// auto-play clock, and every transition between them. UI concerns (terminal
// scrollback, form inputs, naming counters) stay in App; this hook owns only
// what (cluster, op) needs to stay consistent. Ported from opensearchvis.
export function useOpLifecycle(makeInitialCluster) {
  const [cluster, setCluster] = useState(makeInitialCluster)
  const [op, setOp] = useState(null) // { type, step, payload }
  const [opDone, setOpDone] = useState(false)
  const [playing, setPlaying] = useState(false)

  // Mark the op complete once it reaches the final step (survives scrubbing).
  // `playing` is left alone here so the scheduler below can run the last
  // step's dwell — letting the final flight land — before it stops auto-play.
  useEffect(() => {
    if (op && op.step >= lastStep(op.type)) setOpDone(true)
  }, [op])

  // The rendered view of the cluster at the current op step, plus transient
  // per-step info. Memoized so their identities are stable across renders
  // where (cluster, op) didn't change.
  const derived = useMemo(() => deriveCluster(cluster, op), [cluster, op])
  const extra = useMemo(() => opExtra(cluster, op), [cluster, op])

  // Auto-play: the single timeline clock. Each step declares its own duration
  // (stepDuration); when it elapses we advance — or, at the last step, stop,
  // which gives the final flight its dwell. The effect re-subscribes on
  // [playing, op], so manual Prev/Next/Pause (which change those) cancel any
  // pending timer. `extra` is read for content-aware durations but is
  // intentionally NOT a dep: it gets a fresh value on every op change.
  useEffect(() => {
    if (!playing || !op) return
    const atLast = op.step >= lastStep(op.type)
    const id = setTimeout(() => {
      if (atLast) setPlaying(false)
      else setOp((prev) => (prev ? { ...prev, step: prev.step + 1 } : prev))
    }, stepDuration(op, extra))
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, op])

  const canStartNew = op === null || opDone

  // The committed cluster as it will be once the current (completed) op folds
  // in. Null while an op is mid-walk, which disables the terminal.
  const base = canStartNew ? (op ? applyOp(cluster, op) : cluster) : null

  // Fold the previous (finished) op into committed state, then begin the new
  // op at step 0 under auto-play. This "fold before next" is why a completed
  // op can stay rendered without ever being applied twice.
  function start(type, payload) {
    setCluster(base)
    setOp({ type, step: 0, payload })
    setOpDone(false)
    setPlaying(true)
  }

  // Manual scrub: pause, then clamp the step into the op's range.
  function step(delta) {
    setPlaying(false)
    setOp((prev) => {
      if (!prev) return prev
      const next = Math.max(0, Math.min(lastStep(prev.type), prev.step + delta))
      return { ...prev, step: next }
    })
  }

  const play = () => setPlaying(true)
  const pause = () => setPlaying(false)

  // Replace the committed cluster wholesale (reset) and clear the op state so
  // nothing re-derives against the new cluster.
  function resetTo(nextCluster) {
    setCluster(nextCluster)
    setOp(null)
    setOpDone(false)
    setPlaying(false)
  }

  return {
    cluster,
    op,
    opDone,
    playing,
    derived,
    extra,
    base,
    canStartNew,
    start,
    step,
    play,
    pause,
    resetTo,
  }
}
