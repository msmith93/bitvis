import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion'
import FlyingTokens, { selectorRect } from '../../components/tokenFlight'
import { localSearchSteps, computeShardSearch, statsForShard } from '../../ops/search'
import { fmtScore } from '../../relevance'
import { segmentAnatomy } from '../../invertedIndex'
import { matchesAny } from '../../wildcard'
import {
  flightMs,
  DICT_SCAN_MS,
  DICT_SEEK_MS,
  INSPECTOR_DWELL_MS,
  INSPECTOR_FLIGHT_PAD_MS,
  QUERY_SCAN_MS,
} from '../../timing'
import { LOCAL_TOPK } from '../../constants'

// The close-up for a single serving shard during the local-search phase.
//
// A persistent "segment anatomy" diagram (inverted index = term dictionary +
// postings, stored _source, deletes bitset) stays visible while the shell's
// mini-stepper walks the query-phase steps. Transitions are animated end-to-end:
// query tokens fly to the segments, matched doc-ids fly up into the candidate
// lane, and the candidate chips glide into their scored / ranked positions
// (framer layout).
//
// A WILDCARD query takes a different route through the same diagram: the
// dictionary step replays, probe by probe, how the pattern is actually resolved
// against each segment's sorted terms (a seek, or a full enumeration), and an
// extra step collects the terms it expanded to. Steps are addressed by `key`
// rather than index because of that extra step.

// Everything derivable from (shard, search, docs) up front, so the ctx's step
// budget can be computed without rendering. Pure.
function deriveShardLocal({ shard, search, docs }) {
  const patterns = search.patterns
  // Score with exactly the stats the cluster-level run used, or this panel and
  // the results panel would show different numbers for the same document.
  const stats = statsForShard(search, shard.id)
  const local = computeShardSearch(shard, patterns, docs, LOCAL_TOPK, stats)
  const steps = localSearchSteps(patterns)
  return {
    shard,
    search,
    patterns,
    wildcard: search.wildcard,
    stats,
    local,
    anatomy: shard.segments
      .filter((s) => s.searchable)
      .map((s) => segmentAnatomy(s, docs)),
    steps,
    at: Object.fromEntries(steps.map((s, i) => [s.key, i])),
    // Each segment's dictionary resolution, keyed for the anatomy cards.
    scans: Object.fromEntries(local.segments.map((s) => [s.id, s.scan])),
    // Probe budget: the longest segment trace paces the step, and a full
    // enumeration ticks faster than a seek's deliberate bounces.
    maxProbes: Math.max(0, ...local.segments.map((s) => s.scan.probes.length)),
    probeMs: local.segments[0]?.scan.mode === 'scan' ? DICT_SCAN_MS : DICT_SEEK_MS,
  }
}

// The dictionary step has to fit its token flight AND the whole probe replay;
// every other step takes the flat dwell.
const dwellFor = (m, i) =>
  m.wildcard && i === m.at.lookup
    ? flightMs(m.patterns.length) +
      INSPECTOR_FLIGHT_PAD_MS +
      m.maxProbes * m.probeMs +
      INSPECTOR_FLIGHT_PAD_MS
    : INSPECTOR_DWELL_MS

export function build({ shard, search, docs, query, anchor }) {
  const model = deriveShardLocal({ shard, search, docs })
  const sv = search.serving[shard.id]
  return {
    key: `shard-${shard.id}`,
    title: (
      <>
        shard {shard.id} · <span className={'role-badge ' + sv.role}>{sv.role}</span> on{' '}
        {sv.node}
        <span className="si-sub"> — local search</span>
      </>
    ),
    sub: `shard ${shard.id} · local search`,
    steps: model.steps,
    dwell: (i) => dwellFor(model, i),
    source: anchor,
    // NOTE: Stage is a module-scope component, and the model is handed over as a
    // prop. Defining it inside build() would give it a new identity on every
    // re-derive, remounting the stage and losing the flight/probe state
    // mid-choreography.
    Stage: ShardLocalStage,
    stageProps: { model, docs, query },
  }
}

function ShardLocalStage({ step, active, openCloseUp, model, docs, query }) {
  const { shard, search, patterns, wildcard, local, anatomy, at, scans, maxProbes, probeMs } =
    model

  const [arrived, setArrived] = useState(true) // has the current step's flight landed?
  const [flights, setFlights] = useState([])
  const [probeIdx, setProbeIdx] = useState(0) // probes replayed on the dictionary step
  const prevStepRef = useRef(0)

  // Choreography: on FORWARD entry to a flight step, launch the flight(s) and hold
  // the step's highlight/reveal until they land. Backward / jumps skip flights and
  // show the end-state instantly. Runs in a layout effect so `arrived=false` is
  // committed before paint (no highlight flicker), with rects measured post-layout.
  useLayoutEffect(() => {
    const prev = prevStepRef.current
    prevStepRef.current = step
    const forward = step > prev

    if (forward && (step === at.lookup || step === at.postings)) {
      setArrived(false)
      const built = step === at.lookup ? buildLookupFlights() : buildCandidateFlights()
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

  // Replay the dictionary probes once the query chips have landed. Leaving the
  // step forwards parks the replay at "finished" (so later steps show every
  // matched term); leaving it backwards rewinds it to nothing. A nested close-up
  // covering this panel parks it at "finished" too — a replay ticking behind a
  // child panel would be finished-but-unseen by the time the user came back.
  useEffect(() => {
    if (!wildcard) return
    if (!active) {
      setProbeIdx(maxProbes)
      return
    }
    if (step !== at.lookup) {
      setProbeIdx(step > at.lookup ? maxProbes : 0)
      return
    }
    if (!arrived) {
      setProbeIdx(0)
      return
    }
    let i = 0
    setProbeIdx(0)
    const id = setInterval(() => {
      i += 1
      setProbeIdx(i)
      if (i >= maxProbes) clearInterval(id)
    }, probeMs)
    return () => clearInterval(id)
  }, [wildcard, active, step, arrived, at.lookup, maxProbes, probeMs])

  // query term / pattern chips fly from the query bar down to each segment's
  // inverted index; a segment scrolled below the fold gets a token that exits the
  // bottom edge.
  function buildLookupFlights() {
    const from = selectorRect('.si-query-box')
    if (!from) return []
    const scRect = selectorRect('.si-scroll')
    const tokens = search.terms.map((t, i) => ({
      id: `q-${i}-${t}`,
      term: t,
      color: 'var(--accent)',
    }))
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

  // The probe replay owns the dictionary highlighting while it is running: terms
  // light up as the scan reaches them, not all at once.
  const scanning = wildcard && step === at.lookup && arrived && active
  const focus = {
    matches: (term) => matchesAny(term, patterns),
    candidateSet: new Set(local.candidates),
    dictHL: step > at.lookup || (step === at.lookup && arrived), // term dictionary lookup
    postingsHL: step >= at.postings, // postings walked (source of the candidate flight)
    sourceHL: step >= at.return, // _source read on return/fetch
  }
  // candidate lane items appear once the postings-step flight has landed.
  const laneRevealed = step >= at.score || (step === at.postings && arrived)

  const removeFlight = (key) => setFlights((f) => f.filter((x) => x.key !== key))

  return (
    <>
      {/* Persistent query box — stays visible across every phase. */}
      <QueryBox query={query} terms={search.terms} step={step} />

      <div className="si-scroll">
        {step === at.expand && <ExpansionBlock local={local} />}

        {step >= at.postings && (
          <ResultsLane
            step={step}
            at={at}
            local={local}
            docs={docs}
            revealed={laneRevealed}
            shard={shard}
            openCloseUp={openCloseUp}
          />
        )}

        <p className="section-title">
          Segment anatomy — what this shard stores
          <span className="si-hint">
            {' '}
            — this table is a drawing; the 🔍 on a column shows the files it is
            really made of
          </span>
        </p>
        <div className="si-anatomy">
          {anatomy.length === 0 ? (
            <div className="empty-note small">nothing searchable on this shard</div>
          ) : (
            anatomy.map((seg) => (
              <AnatomyCard
                key={seg.id}
                seg={seg}
                focus={focus}
                docs={docs}
                scan={scans[seg.id]}
                probeIdx={scanning ? probeIdx : null}
                showCost={wildcard && step >= at.lookup}
                shardId={shard.id}
                wildcard={wildcard}
                openCloseUp={openCloseUp}
              />
            ))
          )}
        </div>
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

// What a wildcard actually expanded to, plus what reading the dictionaries cost.
// From here on the query is an ordinary boolean OR over these terms.
function ExpansionBlock({ local }) {
  const pct = local.dictTotal
    ? Math.round((local.examined / local.dictTotal) * 100)
    : 0
  return (
    <div className="si-block">
      <p className="section-title">Pattern expanded to</p>
      <div className="si-expansion">
        {local.matchedTerms.length === 0 ? (
          <div className="ss-none">no terms matched</div>
        ) : (
          local.matchedTerms.map((t) => (
            <motion.span
              key={t}
              className="term-chip"
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ type: 'spring', stiffness: 320, damping: 22 }}
            >
              {t}
            </motion.span>
          ))
        )}
      </div>
      <div className="dict-cost total">
        {local.examined} of {local.dictTotal} dictionary terms read ({pct}%) across{' '}
        {local.segments.length} segment{local.segments.length === 1 ? '' : 's'} on this
        shard alone
      </div>
    </div>
  )
}

// The persistent results lane. One chip per docId, carried across phases via
// layoutId so framer animates every reposition: candidates → scored order →
// ranked slots (evicted peel off) → returned list.
function ResultsLane({ step, at, local, docs, revealed, shard, openCloseUp }) {
  const mode =
    step === at.postings
      ? 'candidates'
      : step === at.score
      ? 'score'
      : step === at.topk
      ? 'topk'
      : 'return'
  const titles = {
    candidates: 'Candidate docs (union of posting lists)',
    score: 'Score each candidate (BM25)',
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
                          {Object.entries(sc.perTerm).map(([t, f]) => (
                            <span key={t} className="si-tf" title={`idf ${f.idf.toFixed(3)} · df ${f.docFreq}`}>
                              {t} ×{f.tf} → {fmtScore(f.contribution)}
                            </span>
                          ))}
                        </span>
                      )}
                      {mode === 'score' && sc && (
                        <span className="score" data-score-chip={it.docId}>
                          = {fmtScore(sc.score)}
                          {/* Down one more level: the whole BM25 arithmetic for
                              this one document. */}
                          <button
                            className="magnify-btn inline"
                            data-tour="magnify-score"
                            title="Zoom into how this score was computed"
                            onClick={() =>
                              openCloseUp?.({
                                kind: 'scoring',
                                shard: shard.id,
                                docId: it.docId,
                              })
                            }
                          >
                            🔍
                          </button>
                        </span>
                      )}
                      {(mode === 'topk' || mode === 'return') && (
                        <span className="score">
                          {mode === 'return' ? 'score ' : ''}
                          {fmtScore(sc?.score ?? it.score)}
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
                  <span className="score">{fmtScore(s.score)}</span>
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

// Which dictionary rows the replay has touched so far, for one segment. Returns
// null unless a probe replay is running, in which case the term dictionary is
// rendered from THIS rather than from "every matching term".
function probeView(scan, probeIdx) {
  if (!scan || probeIdx == null) return null
  const played = Math.min(probeIdx, scan.probes.length)
  const examined = new Set()
  const matched = new Set()
  for (let i = 0; i < played; i++) {
    const p = scan.probes[i]
    examined.add(p.i)
    if (p.match) matched.add(p.i)
  }
  const cur = played > 0 && probeIdx <= scan.probes.length ? scan.probes[played - 1] : null
  return {
    examined,
    matched,
    cursor: cur ? cur.i : null,
    phase: cur ? cur.phase : null,
    lo: cur && cur.phase === 'seek' ? cur.lo : null,
    hi: cur && cur.phase === 'seek' ? cur.hi : null,
    count: examined.size,
    done: played >= scan.probes.length,
  }
}

// One segment's stored structures: inverted index (term dictionary | postings),
// stored _source, and the deletes (live-docs) bitset. The same card lights up
// differently depending on `focus` (which query step we're on) and, for a
// wildcard, on how far the dictionary probe replay has got.
function AnatomyCard({
  seg,
  focus,
  docs,
  scan,
  probeIdx,
  showCost,
  shardId,
  wildcard,
  openCloseUp,
}) {
  const { matches, dictHL, postingsHL, sourceHL, candidateSet } = focus
  const rowsRef = useRef(null)
  const matchRef = useRef(null)
  const cursorRef = useRef(null)
  const view = probeView(scan, probeIdx)
  const cursor = view?.cursor ?? null

  // When the lookup highlight activates, scroll this segment's term dictionary so
  // its first matching term is in view. Contained to the .anat-ii-rows scroller.
  // Skipped while a probe replay is running — the cursor effect below owns
  // scrolling then.
  useEffect(() => {
    if (view || !dictHL || !rowsRef.current || !matchRef.current) return
    const rows = rowsRef.current
    const top =
      rows.scrollTop +
      (matchRef.current.getBoundingClientRect().top - rows.getBoundingClientRect().top)
    rows.scrollTo({ top, behavior: 'smooth' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dictHL, !!view])

  // Follow the probe. Instant, and only when the cursor has left the visible
  // box — a smooth scroll per tick would never settle at scan speed.
  useEffect(() => {
    if (cursor == null || !rowsRef.current || !cursorRef.current) return
    const rows = rowsRef.current
    const box = rows.getBoundingClientRect()
    const row = cursorRef.current.getBoundingClientRect()
    if (row.top < box.top || row.bottom > box.bottom)
      rows.scrollTop += row.top - box.top - box.height / 2 + row.height / 2
  }, [cursor])

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
          <div className="anat-ii-label">
            inverted index
            {showCost && scan && (
              <span className={'dict-cost' + (view?.done === false ? ' live' : '')}>
                {scan.mode === 'seek' ? 'seek · ' : 'full scan · '}
                examined {view ? view.count : scan.examined} / {scan.total}
              </span>
            )}
          </div>
          <div className="anat-ii-cols">
            <div className="anat-col-head">
              term dictionary
              {openCloseUp && (
                <button
                  className="magnify-btn inline"
                  data-anat-dict={seg.id}
                  title="What the term dictionary really is on disk: .tip (an FST) + .tim (blocks)"
                  onClick={() => openCloseUp({ kind: 'dictionary', shard: shardId, seg: seg.id })}
                >
                  🔍
                </button>
              )}
            </div>
            {/* No 🔍 here: a posting list's on-disk encoding was its own zoom and
                was removed. What it stores — which documents contain the term —
                is what this column already shows, and the encoding detail is not
                demonstrable at this segment size (see SPEC.md). */}
            <div className="anat-col-head">postings</div>
          </div>
          <div className="anat-ii-rows" ref={rowsRef}>
            {seg.terms.map(({ term, docIds }, i) => {
              const isQ = matches(term)
              // While the replay runs, a term only lights up once the scan has
              // actually reached it — that IS the lesson.
              const hit = view ? view.matched.has(i) : isQ && dictHL
              const dim = view ? !view.matched.has(i) : dictHL && !isQ
              const isFirstMatch = !view && isQ && !firstMatchSeen
              if (isFirstMatch) firstMatchSeen = true
              const isCursor = view && view.cursor === i
              return (
                <div
                  key={term}
                  ref={isCursor ? cursorRef : isFirstMatch ? matchRef : null}
                  className={
                    'anat-row' +
                    (hit ? ' term-active' : '') +
                    (dim ? ' dim' : '') +
                    (view?.examined.has(i) ? ' examined' : '') +
                    (isCursor ? ` probe-${view.phase}` : '') +
                    (view && view.lo === i ? ' probe-lo' : '') +
                    (view && view.hi === i ? ' probe-hi' : '')
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
// shown immediately. Also the source anchor for the lookup-step flights.
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
