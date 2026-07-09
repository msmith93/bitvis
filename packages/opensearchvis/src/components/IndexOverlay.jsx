import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { analyzeDoc } from '../analyzer'
import { lastStep } from '../ops'
import { INDEX_SCAN_MS, INDEX_ANALYSIS_LEAD_MS } from '../timing'
import FlyingTokens, { selectorRect } from './tokenFlight'

// The indexing experience as a presentation layer DRIVEN BY the live op step, so
// the document visibly travels through the cluster in lockstep with the footer:
//
//   editing → flying ( op.step 0..4 ) → done → (Index another) → editing
//
//   step 0 coordinator : doc shrinks + floats to Node 1
//   step 1 route       : doc floats to the routed primary shard
//   step 2 analysis    : scan sweeps the doc, then tokens fly into the shard
//   step 3 primary     : doc dissolves into the buffer (cluster animates)
//   step 4 replicate   : replica copy animates in the cluster
export default function IndexOverlay({
  presets,
  title,
  body,
  setTitle,
  setBody,
  canIndex,
  targetShard,
  docColor,
  onIndex,
  op,
  playing,
  phase,
  setPhase,
}) {
  const [tokens, setTokens] = useState([])
  const [flight, setFlight] = useState(null) // { from, to } — analysis → primary
  const [replicaFlight, setReplicaFlight] = useState(null) // primary → replica
  const [target, setTarget] = useState(null) // { x, y, scale } for the floating doc
  const [scanning, setScanning] = useState(false)
  const [showTokens, setShowTokens] = useState(false) // tokens visible inside the card
  const [docHidden, setDocHidden] = useState(false)
  const cardRef = useRef(null) // the editing form card
  const flyRef = useRef(null) // the floating doc card
  const startRef = useRef(null) // editing-card rect captured at submit
  const shardRef = useRef(targetShard) // routed shard of the doc being indexed
  const handledStep = useRef(-1)

  function handleIndex() {
    if (!canIndex) return
    const a = analyzeDoc({ title: title.trim(), body: body.trim() })
    const terms = [...a.title, ...a.body]
    setTokens(terms.map((term, i) => ({ id: `${i}-${term}`, term, color: docColor })))
    startRef.current = cardRef.current?.getBoundingClientRect() || null
    // Capture NOW: onIndex() advances docNum, so the targetShard prop will flip
    // to the next doc on the following render.
    shardRef.current = targetShard
    setTarget(null)
    setScanning(false)
    setShowTokens(false)
    setDocHidden(false)
    setReplicaFlight(null)
    handledStep.current = -1
    setPhase('flying')
    onIndex() // start the real op at step 0; auto-play + footer take over pacing
  }

  // Centre of a DOM anchor minus half the (transform-independent) fly-card size,
  // so the card's visual centre lands on the anchor under scaling.
  function anchorTarget(selector, scale) {
    const r = selectorRect(selector)
    if (!r) return null
    const w = flyRef.current?.offsetWidth || 220
    const h = flyRef.current?.offsetHeight || 120
    return { x: r.left + r.width / 2 - w / 2, y: r.top + r.height / 2 - h / 2, scale }
  }

  function beginEmit() {
    const from = flyRef.current?.getBoundingClientRect()
    const to = selectorRect(`[data-shard-target="${shardRef.current}"]`)
    setFlight({ from, to })
  }

  function finishEmit() {
    setFlight(null)
  }

  // The doc's data copying from its primary shard to the replica on another node.
  function beginReplicate() {
    const from = selectorRect(`[data-shard-target="${shardRef.current}"]`)
    const to = selectorRect(`[data-replica-target="${shardRef.current}"]`)
    if (from && to) setReplicaFlight({ from, to })
  }

  // React to each op step while flying: reposition the doc + fire scan/emit once.
  useEffect(() => {
    if (phase !== 'flying' || !op || op.type !== 'index') return
    const step = op.step
    if (handledStep.current === step) return
    handledStep.current = step

    const shardSel = `[data-shard-target="${shardRef.current}"]`

    if (step === 0) {
      setTarget(anchorTarget('[data-coordinator]', 0.5))
    } else if (step === 1) {
      setTarget(anchorTarget(shardSel, 0.5))
    } else if (step === 2) {
      // Park at the shard and grow so the analysis is readable. The scheduler
      // reserves a longer duration for this step (stepDuration), so the scan →
      // tokens-in-box → fly sequence runs to completion before it advances.
      setTarget(anchorTarget(shardSel, 0.85))
      setScanning(true)
      const t1 = setTimeout(() => {
        setScanning(false)
        setShowTokens(true) // tokens appear inside the box (the analyzer's output)
      }, INDEX_SCAN_MS)
      const t2 = setTimeout(() => {
        setShowTokens(false) // ...then they leave the box...
        beginEmit() // ...and fly into the primary shard
      }, INDEX_ANALYSIS_LEAD_MS)
      return () => {
        clearTimeout(t1)
        clearTimeout(t2)
      }
    } else if (step < lastStep('index')) {
      setDocHidden(true) // step 3: doc dissolves into the buffer
    } else {
      setDocHidden(true)
      beginReplicate() // last step: copy to the replica on another node
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, op?.step])

  // Close the overlay once auto-play finishes the final (replicate) step: the
  // scheduler holds `playing` true through that step's dwell, then drops it —
  // so the replica flight has landed by the time we flip to 'done'.
  useEffect(() => {
    if (
      phase === 'flying' &&
      op?.type === 'index' &&
      op.step >= lastStep('index') &&
      !playing
    ) {
      setPhase('done')
    }
  }, [phase, op, playing, setPhase])

  // Reset transient bits whenever we return to the editing form.
  useEffect(() => {
    if (phase === 'editing') {
      setTokens([])
      setFlight(null)
      setReplicaFlight(null)
      setTarget(null)
      setScanning(false)
      setShowTokens(false)
      setDocHidden(false)
    }
  }, [phase])

  const editing = phase === 'editing'
  const flying = phase === 'flying'
  const start = startRef.current

  return (
    <>
      <AnimatePresence>
        {editing && (
          <motion.div
            className="index-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4 }}
          />
        )}
      </AnimatePresence>

      {/* ---- editing form (centred modal) ---- */}
      <AnimatePresence>
        {editing && (
          <div className="index-overlay-root">
            <motion.div
              ref={cardRef}
              className="index-card"
              data-tour="index-card"
              initial={{ scale: 0.92, opacity: 0, y: 8 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ type: 'spring', stiffness: 240, damping: 26 }}
            >
              <p className="section-title">Index a document</p>
              <div className="presets">
                {presets.map((p) => (
                  <button
                    key={p.name}
                    className="preset-chip"
                    onClick={() => {
                      setTitle(p.title)
                      setBody(p.body)
                    }}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
              <label className="field">
                <span>title</span>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <label className="field">
                <span>body</span>
                <textarea value={body} onChange={(e) => setBody(e.target.value)} />
              </label>
              <button
                className="btn primary block"
                onClick={handleIndex}
                disabled={!canIndex}
              >
                Index document
              </button>
              <p className="overlay-hint">
                The document routes to a coordinator, then to shard {targetShard}'s
                primary, where it's analyzed into terms and buffered.
              </p>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ---- floating document travelling through the cluster ---- */}
      <AnimatePresence>
        {flying && !docHidden && (
          <motion.div
            ref={flyRef}
            className={'index-fly-card' + (scanning ? ' scanning' : '')}
            initial={{
              x: start ? start.left : 0,
              y: start ? start.top : 0,
              scale: 1,
              opacity: 0,
            }}
            animate={
              target
                ? { x: target.x, y: target.y, scale: target.scale, opacity: 1 }
                : { opacity: 1 }
            }
            exit={{ opacity: 0, scale: 0.5 }}
            transition={{ type: 'spring', stiffness: 120, damping: 20 }}
          >
            {scanning && <div className="scan-line" />}
            <div className="fly-label">doc · shard {shardRef.current}</div>
            <div className="fly-title">{title.trim() || '—'}</div>
            <div className="fly-body">{body.trim() || '—'}</div>
            {showTokens && (
              <div className="chip-row fly-tokens">
                {tokens.map((t, i) => (
                  <motion.span
                    key={t.id}
                    className="analyze-token"
                    style={{ background: t.color }}
                    initial={{ opacity: 0, scale: 0.6 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: i * 0.04, type: 'spring', stiffness: 320, damping: 22 }}
                  >
                    {t.term}
                  </motion.span>
                ))}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {flight && (
        <FlyingTokens
          tokens={tokens}
          from={flight.from}
          to={flight.to}
          onComplete={finishEmit}
        />
      )}

      {replicaFlight && (
        <FlyingTokens
          tokens={tokens}
          from={replicaFlight.from}
          to={replicaFlight.to}
          onComplete={() => setReplicaFlight(null)}
        />
      )}
    </>
  )
}
