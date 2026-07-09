import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion'
import FlyingTokens, { rectCenter, selectorRect } from './tokenFlight'
import { LOCAL_SEARCH_STEPS, computeShardSearch } from '../ops/search'
import { segmentAnatomy } from '../invertedIndex'
import {
  flightMs,
  INSPECTOR_DWELL_MS,
  INSPECTOR_FLIGHT_PAD_MS,
  QUERY_SCAN_MS,
} from '../timing'
import { LOCAL_TOPK } from '../constants'
import Stepper from './Stepper'

// Step indices into LOCAL_SEARCH_STEPS: analyze(0) lookup(1) postings(2)
// score(3) topk(4) return(5).

// A zoom-in overlay for a single serving shard during the local-search phase.
// A persistent "segment anatomy" diagram (inverted index = term dictionary +
// postings, stored _source, deletes bitset) stays visible while a mini-stepper
// walks the six query-phase steps. Transitions are animated end-to-end: query
// tokens fly to the segments, matched doc-ids fly up into the candidate lane, and
// the candidate chips glide into their scored / ranked positions (framer layout).
export default function ShardInspector({ shard, search, docs, query, onClose }) {
  const open = !!shard && !!search

  let initial = { opacity: 0, scale: 0.25 }
  if (open) {
    const role = search.serving[shard.id]?.role
    const c = rectCenter(
      selectorRect(
        role === 'replica'
          ? `[data-replica-target="${shard.id}"]`
          : `[data-shard-target="${shard.id}"]`,
      ),
    )
    if (c)
      initial = {
        opacity: 0,
        scale: 0.25,
        x: c.x - window.innerWidth / 2,
        y: c.y - window.innerHeight / 2,
      }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="shard-inspector-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={onClose}
        >
          <motion.div
            className="shard-inspector"
            initial={initial}
            animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
            exit={initial}
            transition={{ type: 'spring', stiffness: 260, damping: 26 }}
            onClick={(e) => e.stopPropagation()}
          >
            <InspectorBody
              shard={shard}
              search={search}
              docs={docs}
              query={query}
              onClose={onClose}
            />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function InspectorBody({ shard, search, docs, query, onClose }) {
  const sv = search.serving[shard.id]
  const terms = search.terms
  const local = useMemo(
    () => computeShardSearch(shard, terms, docs, LOCAL_TOPK),
    [shard, terms, docs],
  )
  const anatomy = useMemo(
    () =>
      shard.segments.filter((s) => s.searchable).map((s) => segmentAnatomy(s, docs)),
    [shard, docs],
  )

  const last = LOCAL_SEARCH_STEPS.length - 1
  const [step, setStep] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [arrived, setArrived] = useState(true) // has the current step's flight landed?
  const [flights, setFlights] = useState([])
  const prevStepRef = useRef(0)

  // Auto-play clock.
  useEffect(() => {
    if (!playing) return
    if (step >= last) {
      setPlaying(false)
      return
    }
    const id = setTimeout(() => setStep((s) => Math.min(last, s + 1)), INSPECTOR_DWELL_MS)
    return () => clearTimeout(id)
  }, [playing, step, last])

  // Choreography: on FORWARD entry to a flight step, launch the flight(s) and hold
  // the step's highlight/reveal until they land. Backward / jumps skip flights and
  // show the end-state instantly. Runs in a layout effect so `arrived=false` is
  // committed before paint (no highlight flicker), with rects measured post-layout.
  useLayoutEffect(() => {
    const prev = prevStepRef.current
    prevStepRef.current = step
    const forward = step > prev

    if (forward && (step === 1 || step === 2)) {
      setArrived(false)
      const built = step === 1 ? buildLookupFlights() : buildCandidateFlights()
      setFlights(built)
      const n = Math.max(1, ...built.map((f) => f.tokens.length))
      const t = setTimeout(() => {
        setArrived(true)
        setFlights([])
      }, flightMs(n) + INSPECTOR_FLIGHT_PAD_MS)
      return () => clearTimeout(t)
    }
    setArrived(true)
    setFlights([])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  // query term chips fly from the query bar down to each segment's inverted index;
  // a segment scrolled below the fold gets a token that exits the bottom edge.
  function buildLookupFlights() {
    const from = selectorRect('.si-query-box')
    if (!from) return []
    const scRect = selectorRect('.si-scroll')
    const tokens = terms.map((t, i) => ({ id: `q-${i}-${t}`, term: t, color: 'var(--accent)' }))
    if (!tokens.length) return []
    return anatomy
      .map((seg) => {
        const r = selectorRect(`[data-anat-ii="${seg.id}"]`)
        if (!r) return null
        const offscreen = scRect && r.top > scRect.bottom - 8
        const to = offscreen
          ? { left: r.left + r.width / 2, top: window.innerHeight + 40, width: 0, height: 0 }
          : r
        return { key: `look-${seg.id}`, from, to, tokens }
      })
      .filter(Boolean)
  }

  // matched doc-ids fly UP from their postings into the candidate lane.
  function buildCandidateFlights() {
    const to = selectorRect('[data-lane-target]')
    if (!to) return []
    const scRect = selectorRect('.si-scroll')
    const bottomOrigin = (x) => ({
      left: x ?? (scRect ? scRect.left + scRect.width / 2 : window.innerWidth / 2),
      top: window.innerHeight + 40,
      width: 0,
      height: 0,
    })
    return local.candidates.map((id) => {
      const src = document.querySelector(`[data-posting-chip="${id}"]`)
      let from
      if (src) {
        const r = src.getBoundingClientRect()
        from = scRect && r.top > scRect.bottom - 8 ? bottomOrigin(r.left + r.width / 2) : r
      } else {
        from = bottomOrigin()
      }
      return {
        key: `cand-${id}`,
        from,
        to,
        tokens: [{ id: `c-${id}`, term: id, color: docs[id]?.color }],
      }
    })
  }

  const go = (delta) => {
    setPlaying(false)
    setStep((s) => Math.max(0, Math.min(last, s + delta)))
  }

  const current = LOCAL_SEARCH_STEPS[step]
  const focus = {
    queryTerms: new Set(terms),
    candidateSet: new Set(local.candidates),
    dictHL: step >= 2 || (step === 1 && arrived), // term dictionary lookup
    postingsHL: step >= 2, // postings walked (source of the candidate flight)
    sourceHL: step >= 5, // _source read on return/fetch
  }
  // candidate lane items appear once the step-2 flight has landed.
  const laneRevealed = step >= 3 || (step === 2 && arrived)

  const removeFlight = (key) => setFlights((f) => f.filter((x) => x.key !== key))

  return (
    <>
      <div className="si-head">
        <div className="si-title">
          shard {shard.id} ·{' '}
          <span className={'role-badge ' + sv.role}>{sv.role}</span> on {sv.node}
          <span className="si-sub"> — local search</span>
        </div>
        <button className="si-close" onClick={onClose} title="Close">
          ✕
        </button>
      </div>

      <div className="si-explain">
        <h4>{current.title}</h4>
        <p>{current.blurb}</p>
      </div>

      {/* Persistent query box — stays visible across every phase. */}
      <QueryBox query={query} terms={terms} step={step} />

      <div className="si-scroll">
        {step >= 2 && (
          <ResultsLane
            step={step}
            local={local}
            terms={terms}
            docs={docs}
            revealed={laneRevealed}
          />
        )}

        <p className="section-title">Segment anatomy — what this shard stores</p>
        <div className="si-anatomy">
          {anatomy.length === 0 ? (
            <div className="empty-note small">nothing searchable on this shard</div>
          ) : (
            anatomy.map((seg) => (
              <AnatomyCard key={seg.id} seg={seg} focus={focus} docs={docs} />
            ))
          )}
        </div>
      </div>

      <div className="si-stepper">
        <Stepper
          steps={LOCAL_SEARCH_STEPS}
          step={step}
          opLabel={`shard ${shard.id} · local search`}
          playing={playing}
          onPrev={() => go(-1)}
          onNext={() => go(1)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
        />
      </div>

      {/* Flight layer portaled to <body> so the panel's transform can't make these
          fixed tokens panel-relative; they stay in viewport coordinates. */}
      {createPortal(
        flights.map((f) => (
          <FlyingTokens
            key={f.key}
            tokens={f.tokens}
            from={f.from}
            to={f.to}
            onComplete={() => removeFlight(f.key)}
          />
        )),
        document.body,
      )}
    </>
  )
}

// The persistent results lane (steps 2–5). One chip per docId, carried across
// phases via layoutId so framer animates every reposition: candidates → scored
// order → ranked slots (evicted peel off) → returned list.
function ResultsLane({ step, local, terms, docs, revealed }) {
  const mode =
    step === 2 ? 'candidates' : step === 3 ? 'score' : step === 4 ? 'topk' : 'return'
  const titles = {
    candidates: 'Candidate docs (union of posting lists)',
    score: 'Score each candidate (term-frequency stand-in)',
    topk: `Top-k priority queue (k = ${local.k}, a min-heap)`,
    return: 'Local top hits → coordinator',
  }

  let items = []
  let evicted = []
  if (mode === 'candidates') items = local.candidates.map((id) => ({ docId: id }))
  else if (mode === 'score') items = local.scored
  else if (mode === 'topk') {
    items = local.scored.slice(0, local.k)
    evicted = local.scored.slice(local.k)
  } else items = local.topk

  return (
    <div className="si-block">
      <p className="section-title">{titles[mode]}</p>
      <LayoutGroup>
        <div className="si-lane-chips" data-lane-target>
          <AnimatePresence>
            {revealed &&
              (items.length === 0 ? (
                <div className="ss-none">no matching docs</div>
              ) : (
                items.map((it, i) => {
                  const sc = local.scored.find((s) => s.docId === it.docId)
                  return (
                    <motion.div
                      key={it.docId}
                      layout
                      layoutId={`res-${it.docId}`}
                      className="si-lane-item"
                      initial={{ opacity: 0, scale: 0.7 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.7 }}
                      transition={{ type: 'spring', stiffness: 360, damping: 28 }}
                    >
                      {mode === 'topk' && <span className="si-rank">#{i + 1}</span>}
                      <DocChip id={it.docId} docs={docs} hit />
                      {mode === 'score' && sc && (
                        <span className="si-lane-terms">
                          {terms
                            .filter((t) => sc.perTerm[t])
                            .map((t) => (
                              <span key={t} className="si-tf">
                                {t} ×{sc.perTerm[t]}
                              </span>
                            ))}
                        </span>
                      )}
                      {mode === 'score' && sc && <span className="score">= {sc.score}</span>}
                      {(mode === 'topk' || mode === 'return') && (
                        <span className="score">
                          {mode === 'return' ? 'score ' : ''}
                          {sc?.score ?? it.score}
                        </span>
                      )}
                    </motion.div>
                  )
                })
              ))}
          </AnimatePresence>
        </div>

        {mode === 'topk' && evicted.length > 0 && (
          <div className="si-evicted">
            evicted:
            <AnimatePresence>
              {evicted.map((s) => (
                <motion.span
                  key={s.docId}
                  layout
                  layoutId={`res-${s.docId}`}
                  className="si-evicted-chip"
                  exit={{ opacity: 0, scale: 0.6 }}
                  transition={{ type: 'spring', stiffness: 360, damping: 28 }}
                >
                  <DocChip id={s.docId} docs={docs} />
                  <span className="score">{s.score}</span>
                </motion.span>
              ))}
            </AnimatePresence>
          </div>
        )}
      </LayoutGroup>

      {mode === 'return' && <div className="si-return-note">↩ returned to coordinator</div>}
    </div>
  )
}

// One segment's stored structures: inverted index (term dictionary | postings),
// stored _source, and the deletes (live-docs) bitset. The same card lights up
// differently depending on `focus` (which query step we're on).
function AnatomyCard({ seg, focus, docs }) {
  const { queryTerms, dictHL, postingsHL, sourceHL, candidateSet } = focus
  const rowsRef = useRef(null)
  const matchRef = useRef(null)

  // When the lookup highlight activates, scroll this segment's term dictionary so
  // its first matching term is in view. Contained to the .anat-ii-rows scroller.
  useEffect(() => {
    if (!dictHL || !rowsRef.current || !matchRef.current) return
    const rows = rowsRef.current
    const top =
      rows.scrollTop +
      (matchRef.current.getBoundingClientRect().top - rows.getBoundingClientRect().top)
    rows.scrollTo({ top, behavior: 'smooth' })
  }, [dictHL])

  let firstMatchSeen = false
  return (
    <div className="anat-card">
      <div className="anat-card-head">
        <span className="anat-seg-id">
          <span className="lock">🔒</span> {seg.id}
        </span>
        <span className="anat-bitset" title="live-docs bitset (deletes)">
          Live-Docs:
          {seg.docs.map((d) => (
            <span
              key={d.id}
              className={'anat-bit' + (d.deleted || d.purged ? ' dead' : ' live')}
            >
              {d.id} {d.deleted || d.purged ? '✗' : '✓'}
            </span>
          ))}
        </span>
      </div>

      <div className="anat-body">
        {/* inverted index: term dictionary | postings */}
        <div className="anat-ii" data-anat-ii={seg.id}>
          <div className="anat-ii-label">inverted index</div>
          <div className="anat-ii-cols">
            <div className="anat-col-head">term dictionary</div>
            <div className="anat-col-head">postings</div>
          </div>
          <div className="anat-ii-rows" ref={rowsRef}>
            {seg.terms.map(({ term, docIds }) => {
              const isQ = queryTerms.has(term)
              const isFirstMatch = isQ && !firstMatchSeen
              if (isFirstMatch) firstMatchSeen = true
              return (
                <div
                  key={term}
                  ref={isFirstMatch ? matchRef : null}
                  className={
                    'anat-row' +
                    (isQ && dictHL ? ' term-active' : '') +
                    (dictHL && !isQ ? ' dim' : '')
                  }
                >
                  <span className="anat-term">{term}</span>
                  <span className="anat-postings">
                    {docIds.map((id) => {
                      const isCand = isQ && postingsHL && candidateSet.has(id)
                      return (
                        <DocChip key={id} id={id} docs={docs} hit={isCand} anchor={isCand} />
                      )
                    })}
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        {/* stored _source */}
        <div className={'anat-source' + (sourceHL ? ' active' : '')}>
          <div className="anat-ii-label">stored _source</div>
          {seg.docs.map((d) => (
            <div className="anat-doc" key={d.id}>
              <DocChip id={d.id} docs={docs} />
              <span className="anat-doc-text">
                {d.title}
                {d.body ? ` — ${d.body}` : ''}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// Persistent query box — stays visible across ALL phases (the most meaningful
// part of the flow). On the analyze step a scan-line sweeps the box and the
// extracted term chips appear (tokenize + normalize); on later steps the terms are
// shown immediately. Also the source anchor for the step-2 query→segment flights.
function QueryBox({ query, terms, step }) {
  const [scanning, setScanning] = useState(step === 0)
  const [showTokens, setShowTokens] = useState(step !== 0)

  useEffect(() => {
    if (step !== 0) {
      setScanning(false)
      setShowTokens(true)
      return
    }
    setScanning(true)
    setShowTokens(false)
    const t = setTimeout(() => {
      setScanning(false)
      setShowTokens(true)
    }, QUERY_SCAN_MS)
    return () => clearTimeout(t)
  }, [step, query])

  return (
    <div className="si-querybox">
      <div className={'si-query-box' + (scanning ? ' scanning' : '')}>
        {scanning && <div className="scan-line" />}
        <span className="si-query-label">query</span>
        <span className="si-query-str">“{query}”</span>
        <span className="si-arrow">→</span>
        {showTokens ? (
          terms.length ? (
            terms.map((t, i) => (
              <motion.span
                key={t}
                className="term-chip"
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: i * 0.06, type: 'spring', stiffness: 320, damping: 22 }}
              >
                {t}
              </motion.span>
            ))
          ) : (
            <em className="empty-note">no terms</em>
          )
        ) : null}
      </div>
    </div>
  )
}

function DocChip({ id, docs, hit, anchor }) {
  const d = docs[id]
  return (
    <span
      data-posting-chip={anchor ? id : undefined}
      className={'doc-chip' + (d?.deleted ? ' deleted' : '') + (hit ? ' hit' : '')}
      style={{ background: d?.color || '#888' }}
    >
      {id}
    </span>
  )
}
