import { useEffect, useMemo, useState } from 'react'
import { nodeWillFlush, nodeWillFuse } from './cluster'
import { applyOp, deriveCluster, lastStep, opExtra, stepDuration } from './ops'

// The op lifecycle state machine: the committed cluster, the active op, the
// auto-play clock, and every transition between them. UI concerns (form inputs,
// panel tabs, naming counters) stay in App; this hook owns only what
// (cluster, op) needs to stay consistent.
//
// Note that `lastStep` takes the whole op rather than its type: a query's step
// list depends on which phases its rank profile declares (see ops/query.js).
export function useOpLifecycle(makeInitialCluster) {
  const [cluster, setCluster] = useState(makeInitialCluster)
  const [op, setOp] = useState(null) // { type, step, payload }
  const [opDone, setOpDone] = useState(false)
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    if (op && op.step >= lastStep(op)) setOpDone(true)
  }, [op])

  const derived = useMemo(() => deriveCluster(cluster, op), [cluster, op])
  const extra = useMemo(() => opExtra(cluster, op), [cluster, op])

  // Auto-play: the single timeline clock. Each step declares its own duration;
  // when it elapses we advance — or, at the last step, stop, which gives the
  // final flight its dwell. Re-subscribes on [playing, op], so manual
  // Prev/Next/Pause cancel any pending timer.
  useEffect(() => {
    if (!playing || !op) return
    const atLast = op.step >= lastStep(op)
    const id = setTimeout(() => {
      if (atLast) setPlaying(false)
      else setOp((prev) => (prev ? { ...prev, step: prev.step + 1 } : prev))
    }, stepDuration(op, extra))
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, op])

  const canStartNew = op === null || opDone

  // The committed cluster as it will be once the current (completed) op folds
  // in. Null while an op is mid-walk, which is what disables the action buttons.
  const base = canStartNew ? (op ? applyOp(cluster, op) : cluster) : null
  const hasDocs = !!base && Object.values(base.docs).some((d) => !d.removed)
  const hasFlushable = !!base && base.nodes.some(nodeWillFlush)
  const hasFusable = !!base && base.nodes.some((n) => nodeWillFuse(n, base.docs))

  // Fold the previous (finished) op into committed state, then begin the new op
  // at step 0 under auto-play. This "fold before next" is why a completed op can
  // stay rendered without ever being applied twice.
  function start(type, payload) {
    setCluster(base)
    setOp({ type, step: 0, payload })
    setOpDone(false)
    setPlaying(true)
  }

  function step(delta) {
    setPlaying(false)
    setOp((prev) => {
      if (!prev) return prev
      const next = Math.max(0, Math.min(lastStep(prev), prev.step + delta))
      return { ...prev, step: next }
    })
  }

  const play = () => setPlaying(true)
  const pause = () => setPlaying(false)

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
    hasDocs,
    hasFlushable,
    hasFusable,
    start,
    step,
    play,
    pause,
    resetTo,
  }
}
