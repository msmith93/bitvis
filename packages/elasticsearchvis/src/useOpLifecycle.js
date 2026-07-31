import { useEffect, useMemo, useState } from 'react'
import { applyOp, deriveCluster, lastStep, opExtra, stepDuration } from './ops'

// The op lifecycle state machine: the committed cluster, the active op, the
// auto-play clock, and every transition between them. UI concerns (overlay
// phases, zoom, form inputs, doc/segment naming) stay in App; this hook owns
// only what (cluster, op) needs to stay consistent.
export function useOpLifecycle(makeInitialCluster) {
  const [cluster, setCluster] = useState(makeInitialCluster)
  const [op, setOp] = useState(null) // { type, step, payload }
  const [opDone, setOpDone] = useState(false)
  const [playing, setPlaying] = useState(false)

  // Mark the op complete once it reaches the final step (survives scrubbing).
  // `playing` is left alone here so the scheduler below can run the last step's
  // dwell — letting the replica/return flight land — before it stops auto-play.
  useEffect(() => {
    if (op && op.step >= lastStep(op.type)) setOpDone(true)
  }, [op])

  // The rendered view of the cluster at the current op step, plus transient
  // per-step info. Memoized so their identities are stable across renders where
  // (cluster, op) didn't change.
  const derived = useMemo(() => deriveCluster(cluster, op), [cluster, op])
  const extra = useMemo(() => opExtra(cluster, op), [cluster, op])

  // Auto-play: the single timeline clock. Each step declares its own duration
  // (stepDuration); when it elapses we advance — or, at the last step, stop,
  // which gives the final flight its dwell. The effect re-subscribes on
  // [playing, op], so manual Prev/Next/Pause (which change those) cancel any
  // pending timer. `extra` is read for content-aware search durations but is
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

  // The committed cluster as it will be once the current (completed) op folds in.
  // Null while an op is mid-walk, which disables the action buttons.
  const base = canStartNew ? (op ? applyOp(cluster, op) : cluster) : null
  const hasBuffered = !!base && base.shards.some((s) => s.buffer.length > 0)
  const hasPendingDelete =
    !!base && Object.values(base.docs).some((d) => d.deleted && !d.purged)
  const hasUncommitted =
    !!base && base.shards.some((s) => s.segments.some((seg) => !seg.committed))
  const hasMergeable =
    !!base &&
    base.shards.some((s) => s.segments.filter((seg) => seg.searchable).length >= 2)
  const hasSearchable =
    !!base && base.shards.some((s) => s.segments.some((seg) => seg.searchable))

  // Fold the previous (finished) op into committed state, then begin the new op
  // at step 0 under auto-play. This "fold before next" is why a completed op can
  // stay rendered without ever being applied twice.
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

  function toggleDelete(id) {
    const flip = (c) => {
      const d = c.docs[id]
      if (!d) return c
      // Delete records a tombstone; the doc stays searchable until the next
      // refresh applies it (sets `purged`). Undo fully restores the doc.
      const next = d.deleted
        ? { ...d, deleted: false, purged: false }
        : { ...d, deleted: true }
      return { ...c, docs: { ...c.docs, [id]: next } }
    }
    // A finished op is still "active" and re-derived every render. For a completed
    // REFRESH that means a fresh tombstone would be applied (purged) immediately on
    // re-derivation instead of waiting for the next refresh; a completed MERGE could
    // likewise reclaim an applied delete. So, like start(), fold the finished op
    // into the committed cluster first, then tombstone against that.
    if (op && opDone && op.type !== 'search') {
      setCluster(flip(applyOp(cluster, op)))
      setOp(null)
      setOpDone(false)
    } else {
      setCluster((prev) => flip(prev))
    }
  }

  // Replace the committed cluster wholesale (reset / sample data) and clear the
  // op state so nothing re-derives against the new cluster.
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
    hasBuffered,
    hasPendingDelete,
    hasUncommitted,
    hasMergeable,
    hasSearchable,
    start,
    step,
    play,
    pause,
    toggleDelete,
    resetTo,
  }
}
