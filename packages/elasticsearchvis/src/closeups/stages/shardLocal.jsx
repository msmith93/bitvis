import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion'
import FlyingTokens, { selectorRect } from '../../components/tokenFlight'
import { localSearchSteps, computeShardSearch } from '../../ops/search'
import { segmentAnatomy } from '../../invertedIndex'
import { isRootDoc } from '../../cluster'
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
import { useReveal } from '../shared'
import { AnatomyCard, DocChip } from '../anatomy'

// The close-up for a single serving shard during the local-search phase.
//
// A persistent "segment anatomy" diagram (inverted index = term dictionary +
// postings, stored _source) stays visible while the shell's
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
  const local = computeShardSearch(shard, patterns, docs, LOCAL_TOPK)
  // Does this shard actually hold nested blocks? Only then is there a join to
  // draw — on flat data every Lucene doc is already its own document.
  const blocks = shard.segments.some(
    (seg) => seg.searchable && seg.docIds.some((id) => !isRootDoc(docs[id])),
  )
  const steps = localSearchSteps(patterns, { blocks })
  return {
    shard,
    search,
    patterns,
    wildcard: search.wildcard,
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
  // matched term); leaving it backwards rewinds it to nothing — which is the
  // one place this needs `rest` rather than useReveal's default, since a step
  // not yet reached must rest UNSTARTED. A nested close-up covering this panel
  // parks it at "finished" too: a replay ticking behind a child panel would be
  // finished-but-unseen by the time the user came back.
  const probeIdx = useReveal(
    wildcard && active && step === at.lookup && arrived,
    maxProbes,
    probeMs,
    !active || step > at.lookup ? maxProbes : 0,
  )

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
    // child Lucene doc -> the root the parent bitset walks forward to. Empty
    // unless the dataset is nested AND a child actually matched.
    joins: new Map(local.joins.map((j) => [j.child, j.root])),
    joinHL: at.join != null ? step >= at.join : step >= at.postings,
    dictHL: step > at.lookup || (step === at.lookup && arrived), // term dictionary lookup
    postingsHL: step >= at.postings, // postings walked (source of the candidate flight)
    // Deliberately never lit here: the query phase returns ids + scores and
    // opens no stored field. _source is read in the FETCH phase — the fetch
    // step's 🔍 on this shard shows it (stages/shardFetch.jsx → segment.jsx).
    sourceHL: false,
  }
  // candidate lane items appear once the postings-step flight has landed.
  // The intersect and join steps sit BETWEEN postings and score, so they have to
  // be named here explicitly — `step >= at.score` alone would leave them blank.
  // Both are undefined when the query/dataset doesn't warrant them, and
  // `step === undefined` is false, so this stays inert for a plain query.
  const laneRevealed =
    step >= at.score ||
    step === at.intersect ||
    step === at.join ||
    (step === at.postings && arrived)

  const removeFlight = (key) => setFlights((f) => f.filter((x) => x.key !== key))

  return (
    <>
      {/* Persistent query box — stays visible across every phase. */}
      <QueryBox query={query} terms={search.terms} step={step} />

      <div className="si-scroll">
        {step === at.expand && <ExpansionBlock local={local} />}

        {step >= at.postings && (
          <ResultsLane step={step} at={at} local={local} docs={docs} revealed={laneRevealed} />
        )}

        <p className="section-title">
          Segment anatomy — what this shard stores
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
                wildcard={wildcard}
                // The segment zoom is about resolving a term against the on-disk
                // dictionary and walking its posting list — so the 🔍 only shows
                // on the steps where that is what the shard is doing (lookup
                // through postings; `expand` sits between them for a pattern).
                // On score / top-k / return the segment view has nothing to add.
                magnify={
                  openCloseUp && step >= at.lookup && step <= at.postings
                    ? {
                        attr: 'data-anat-dict',
                        title:
                          'Inside this segment: the term index, the term blocks, the postings and the stored fields',
                        onClick: () =>
                          openCloseUp({ kind: 'segment', shard: shard.id, seg: seg.id }),
                      }
                    : null
                }
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
function ResultsLane({ step, at, local, docs, revealed }) {
  const mode =
    step === at.postings
      ? 'candidates'
      : step === at.intersect
      ? 'intersect'
      : step === at.join
      ? 'join'
      : step === at.score
      ? 'score'
      : step === at.topk
      ? 'topk'
      : 'return'
  const titles = {
    candidates: 'Candidate docs (union of posting lists)',
    intersect: 'Every clause must hit the same Lucene doc',
    join: 'Lucene docs → Elasticsearch documents',
    score: 'Score each candidate (term-frequency stand-in)',
    topk: `Top-k priority queue (k = ${local.k}, a min-heap)`,
    return: 'Local top hits → coordinator',
  }

  // The intersect step is the one place a FAILED candidate is worth drawing, so
  // it renders every candidate with its per-clause verdict rather than only the
  // survivors. Without it a doc that matched one clause simply vanishes.
  if (mode === 'intersect')
    return (
      <div className="si-block">
        <p className="section-title">{titles[mode]}</p>
        <div className="si-lane-chips" data-lane-target>
          {!revealed ? null : local.luceneScored.length === 0 ? (
            <div className="ss-none">no candidates</div>
          ) : (
            local.luceneScored.map((h) => (
              <div
                className={'si-lane-item si-clauses' + (h.eliminated ? ' out' : '')}
                key={h.docId}
              >
                <DocChip id={h.docId} docs={docs} hit={!h.eliminated} />
                <span className="si-clause-row">
                  {(h.clauses ?? []).map((c) => (
                    <span key={c.label} className={'si-clause' + (c.hit ? ' yes' : ' no')}>
                      {c.hit ? '✓' : '✗'} {c.label}
                    </span>
                  ))}
                </span>
                {h.eliminated && <span className="si-out-note">dropped — not all clauses</span>}
              </div>
            ))
          )}
        </div>
        {revealed && local.survivors.length === 0 && local.luceneScored.length > 0 && (
          <p className="si-lane-foot">
            Every candidate matched some clause and none matched them all, so this shard
            returns nothing. That is the correct answer.
          </p>
        )}
      </div>
    )

  // The join: one row per DOCUMENT, listing the Lucene docs that collapsed into
  // it. This is the moment several variants become the one product.
  if (mode === 'join')
    return (
      <div className="si-block">
        <p className="section-title">{titles[mode]}</p>
        <div className="si-lane-chips" data-lane-target>
          {!revealed ? null : local.joinRows.length === 0 ? (
            <div className="ss-none">nothing survived to join</div>
          ) : (
            local.joinRows.map((row) => (
              <div className="si-lane-item si-joinrow" key={row.root}>
                <span className="si-join-from">
                  {row.from.map((id) => (
                    <DocChip key={id} id={id} docs={docs} hit />
                  ))}
                </span>
                <span className="si-join-arrow">→</span>
                <DocChip id={row.root} docs={docs} hit />
                <span className="si-join-label">
                  {row.from.length === 1 && row.from[0] === row.root
                    ? 'already a document'
                    : `${row.from.length} lucene doc${row.from.length === 1 ? '' : 's'} → 1 document`}
                </span>
              </div>
            ))
          )}
        </div>
        {revealed && local.joinRows.length > 0 && (
          <p className="si-lane-foot">
            Only documents leave the shard from here — the coordinator never sees a Lucene
            doc, an ordinal or a variant.
          </p>
        )}
      </div>
    )

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
                          {Object.entries(sc.perTerm).map(([t, n]) => (
                            <span key={t} className="si-tf">
                              {t} ×{n}
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
            {/* No shared layoutId with the lane chips: an evicted doc leaves the
                lane (AnimatePresence exit above) and a fresh chip fades in here.
                Flying one element between the two containers meant the same
                layoutId was mounted twice for a frame, which framer resolves by
                oscillating the position — the jitter this used to show. */}
            {evicted.map((s) => (
              <motion.span
                key={s.docId}
                className="si-evicted-chip"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 0.7, y: 0 }}
                transition={{ type: 'spring', stiffness: 340, damping: 30 }}
              >
                <DocChip id={s.docId} docs={docs} />
                <span className="score">{s.score}</span>
              </motion.span>
            ))}
          </div>
        )}
      </LayoutGroup>

      {mode === 'return' && <div className="si-return-note">↩ returned to coordinator</div>}
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
