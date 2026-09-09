import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { buildBlock, makeMapping } from '../mapping'
import { lastStep } from '../ops'
import { INDEX_SCAN_MS, INDEX_ANALYSIS_LEAD_MS, INDEX_REPLICA_HOP_MS } from '../timing'
import FlyingTokens, { selectorRect } from './tokenFlight'

// The indexing experience as a presentation layer DRIVEN BY the live op step, so
// the document visibly travels through the cluster in lockstep with the footer:
//
//   editing → flying ( op.step 0..4 ) → done → (Index another) → editing
//
// The card is on stage for BOTH flying and done (`walking`), and every step
// below re-declares the whole of its visual state, so the walk is scrubbable in
// either direction and at any time — including after it has finished.
//
//   step 0 coordinator : doc shrinks + floats to Node 1
//   step 1 route       : doc floats to the routed primary shard
//   step 2 analysis    : scan sweeps the doc, then tokens fly into the shard
//   step 3 primary     : doc dissolves into the buffer (cluster animates)
//   step 4 replicate   : the DOCUMENT hops to the replica, and the whole of
//                        step 2 replays there — because what is replicated is
//                        the operation, not the terms, and the replica analyzes
//                        for itself. The doc card is therefore kept MOUNTED
//                        (faded, not unmounted) through step 3, so it can fly on
//                        from the primary rather than restarting at the form.
export default function IndexOverlay({
  presets,
  title,
  body,
  setTitle,
  setBody,
  routing = '',
  setRouting,
  canIndex,
  targetShard,
  docColor,
  onIndex,
  op,
  playing,
  phase,
  setPhase,
  variants,
  setVariants,
  nestedPath,
  setNestedPath,
  source,
}) {
  const [tokens, setTokens] = useState([])
  const [flight, setFlight] = useState(null) // { from, to } — analysis → primary
  const [replicaFlight, setReplicaFlight] = useState(null) // the replica's own analysis → its buffer
  const [target, setTarget] = useState(null) // { x, y, scale } for the floating doc
  const [scanning, setScanning] = useState(false)
  const [showTokens, setShowTokens] = useState(false) // tokens visible inside the card
  const [docHidden, setDocHidden] = useState(false)
  // Has the replicate step's choreography actually finished? The overlay used
  // to close as soon as auto-play stopped, which was fine when that step was a
  // single token flight — but it now analyzes at the replica, and a reader who
  // walks the op with Next instead of Play is never `playing` at all, so the
  // whole sequence would be torn down the instant it started.
  const [replicaDone, setReplicaDone] = useState(false)
  const cardRef = useRef(null) // the editing form card
  const flyRef = useRef(null) // the floating doc card
  const startRef = useRef(null) // editing-card rect captured at submit
  // Exactly what pressing Index would write, through the SAME builder the write
  // path uses — so the "writes N Lucene docs" line and the analyzed tokens can
  // never disagree with what lands in the buffer.
  const previewBlock = buildBlock(source, {
    id: 'preview',
    mapping: makeMapping(nestedPath ? ['variants'] : []),
  })

  const shardRef = useRef(targetShard) // routed shard of the doc being indexed
  const handledStep = useRef(-1)

  function handleIndex() {
    if (!canIndex) return
    // Every term the whole BLOCK emits — a nested document analyzes its children
    // too, and the flight should show what actually gets indexed.
    const terms = previewBlock.flatMap((d) => Object.values(d.tokens).flat())
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
    setReplicaDone(false)
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

  // The replica's OWN analyzer output landing in its buffer — the mirror of
  // beginEmit, one node over. Nothing token-shaped ever crosses between the two
  // copies; both of these flights start at the document card.
  function beginReplicaEmit() {
    const from = flyRef.current?.getBoundingClientRect()
    const to = selectorRect(`[data-replica-target="${shardRef.current}"]`)
    setReplicaFlight({ from, to })
  }

  // Is the document on stage? 'flying' is the walk, but 'done' has to count too:
  // it only means auto-play reached the end and the form may be reopened, and
  // gating the card on 'flying' alone meant that finishing an op RETIRED the
  // choreography — scrub back afterwards and the steps narrated a document that
  // was no longer rendered. Staying mounted through 'done' also keeps the card
  // from re-entering from the editing form's old position on the way back.
  const walking = (phase === 'flying' || phase === 'done') && op?.type === 'index'

  // React to each op step while walking: reposition the doc + fire scan/emit once.
  useEffect(() => {
    if (!walking) return
    const step = op.step
    if (handledStep.current === step) return
    handledStep.current = step

    const shardSel = `[data-shard-target="${shardRef.current}"]`

    // Every step declares its own COMPLETE visual state. Each branch below sets
    // only the flags it needs, so without this reset the ones it doesn't touch
    // survive the scrub: step 3 hid the doc card and only the last step ever
    // un-hid it, which left the document invisible on every earlier step once
    // you had walked past the buffer — the scan and the flights still replayed,
    // against a card nobody could see. Same for a scan or a token row abandoned
    // mid-sequence by a Prev.
    setScanning(false)
    setShowTokens(false)
    setDocHidden(false)
    // The flights go too, and not only for tidiness: a batch abandoned by a
    // scrub still runs its own completion timer, and the replica's batch hides
    // the doc card when it lands. Left alone it would fire against whatever
    // step you had scrubbed to and blank the card there. Unmounting cancels the
    // timer (FlyingTokens clears it on cleanup), and no auto-play step can lose
    // a flight this way — every flight's step budgets for it in indexOp.js.
    setFlight(null)
    setReplicaFlight(null)

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
      // Step 3: doc dissolves into the buffer. It only FADES (see the step map)
      // rather than unmounting, so the replicate step can fly this same card on
      // from the primary.
      setDocHidden(true)
    } else {
      // Last step: the primary forwards the OPERATION. The document itself
      // crosses to the replica, which then runs the same analysis — so this is
      // step 2's sequence again, one hop later and against the replica anchor.
      setReplicaDone(false) // re-armed, so scrubbing back and forward replays it
      setTarget(anchorTarget(`[data-replica-target="${shardRef.current}"]`, 0.85))
      const t1 = setTimeout(() => setScanning(true), INDEX_REPLICA_HOP_MS)
      const t2 = setTimeout(() => {
        setScanning(false)
        setShowTokens(true) // the REPLICA's own analyzer output
      }, INDEX_REPLICA_HOP_MS + INDEX_SCAN_MS)
      const t3 = setTimeout(() => {
        setShowTokens(false)
        beginReplicaEmit()
      }, INDEX_REPLICA_HOP_MS + INDEX_ANALYSIS_LEAD_MS)
      return () => {
        clearTimeout(t1)
        clearTimeout(t2)
        clearTimeout(t3)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walking, phase, op?.step])

  // Close the overlay once the final (replicate) step is really over. Both
  // conditions are load-bearing: auto-play holds `playing` true through that
  // step's dwell, and `replicaDone` (set when the replica's own token flight
  // lands) is what keeps a MANUALLY stepped op — never `playing` at all — from
  // tearing the overlay down before the replica has analyzed anything.
  useEffect(() => {
    if (
      phase === 'flying' &&
      op?.type === 'index' &&
      op.step >= lastStep('index') &&
      !playing &&
      replicaDone
    ) {
      setPhase('done')
    }
  }, [phase, op, playing, replicaDone, setPhase])

  // Escape closes the form, matching DeleteDocOverlay. Only while EDITING —
  // once the document is flying there is a live op behind the overlay and the
  // footer stepper owns it.
  useEffect(() => {
    if (phase !== 'editing') return
    const onKey = (e) => e.key === 'Escape' && setPhase('closed')
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, setPhase])

  // Reset transient bits whenever we return to the editing form. NOT docHidden:
  // the previous walk's card is mid-exit at this point, and un-hiding it makes
  // the old document flash back over the cluster while the form springs in.
  // handleIndex clears it (and all of these) at the moment that matters.
  useEffect(() => {
    if (phase === 'editing') {
      setTokens([])
      setFlight(null)
      setReplicaFlight(null)
      setTarget(null)
      setScanning(false)
      setShowTokens(false)
      setReplicaDone(false)
    }
  }, [phase])

  const editing = phase === 'editing'
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
            onClick={() => setPhase('closed')}
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
              <div className="docs-head">
                <p className="section-title">Index a document</p>
                <button
                  className="si-close"
                  onClick={() => setPhase('closed')}
                  title="Close"
                >
                  ✕
                </button>
              </div>
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
              {/* ---- advanced: routing, sub-objects, and how they are mapped ----
                  Collapsed by default: an ordinary document needs none of it.
                  Open it and the form can describe an ARRAY OF SUB-OBJECTS, which
                  is the only shape where `object` and `nested` differ at all. */}
              <details className="adv" open={variants.length > 0 || !!routing.trim()}>
                <summary>Advanced — routing &amp; mapping</summary>

                {/* Optional _routing. Leave it empty and the shard comes from the
                    _id; fill it in and the target below changes as you type. */}
                <label className="field">
                  <span>routing key</span>
                  <input
                    type="text"
                    value={routing}
                    onChange={(e) => setRouting(e.target.value)}
                    placeholder="optional — hashed instead of the _id"
                  />
                </label>

                <div className="adv-map">
                  <span className="adv-label">variants mapped as</span>
                  {[
                    ['object', false, 'flattened into this document'],
                    ['nested', true, 'one hidden Lucene doc each'],
                  ].map(([name, on, hint]) => (
                    <label key={name} className={'adv-radio' + (nestedPath === on ? ' on' : '')}>
                      <input
                        type="radio"
                        name="mapping"
                        checked={nestedPath === on}
                        onChange={() => setNestedPath(on)}
                      />
                      <b>{name}</b>
                      <span>{hint}</span>
                    </label>
                  ))}
                </div>

                {variants.map((v, i) => (
                  <div className="adv-row" key={i}>
                    <span className="adv-idx">variants[{i}]</span>
                    {['color', 'size'].map((f) => (
                      <input
                        key={f}
                        type="text"
                        placeholder={f}
                        value={v[f] ?? ''}
                        onChange={(e) =>
                          setVariants(
                            variants.map((x, n) =>
                              n === i ? { ...x, [f]: e.target.value } : x,
                            ),
                          )
                        }
                      />
                    ))}
                    <button
                      className="mini"
                      title="remove this sub-object"
                      onClick={() => setVariants(variants.filter((_, n) => n !== i))}
                    >
                      ✕
                    </button>
                  </div>
                ))}

                <button
                  className="btn block adv-add"
                  onClick={() => setVariants([...variants, { color: '', size: '' }])}
                >
                  ＋ add a variant
                </button>
              </details>

              <button
                className="btn primary block"
                onClick={handleIndex}
                disabled={!canIndex}
              >
                Index document
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ---- floating document travelling through the cluster ---- */}
      <AnimatePresence>
        {/* Stays MOUNTED for the whole flight and fades instead of unmounting
            (see the step map above): the replicate step flies this same card on
            from the primary, and beginReplicaEmit reads its rect. */}
        {walking && (
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
                ? { x: target.x, y: target.y, scale: target.scale, opacity: docHidden ? 0 : 1 }
                : { opacity: docHidden ? 0 : 1 }
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
          onComplete={() => {
            setReplicaFlight(null)
            setDocHidden(true) // dissolves into the replica's buffer, as on the primary
            setReplicaDone(true) // ...and only now may the overlay close
          }}
        />
      )}
    </>
  )
}
