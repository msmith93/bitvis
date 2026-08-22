import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { analyzeDoc } from './analyzer'
import {
  PRESETS,
  EXAMPLE_QUERIES,
  WILDCARD_QUERIES,
  DATASETS,
} from './presets'
import {
  docRoute,
  initialCluster,
  routeShard,
  SHARD_PLACEMENT,
} from './cluster'
import { OP_LABELS, opNote, stepsFor } from './ops'
import { useOpLifecycle } from './useOpLifecycle'
import ClusterStage from './components/ClusterStage'
import IndexOverlay from './components/IndexOverlay'
import InvertedIndexTable from './components/InvertedIndexTable'
import SearchFlight from './components/SearchFlight'
import SearchResultsPanel from './components/SearchResultsPanel'
import { CloseUp, buildCloseUp, closeUpAnchor, closeUpStillValid } from './closeups'
import DeleteDocOverlay from './components/DeleteDocOverlay'
import Stepper from './components/Stepper'
import CookieBanner from './components/CookieBanner'
import Walkthrough from './components/Walkthrough'
import ScenarioPicker from './components/ScenarioPicker'
import DocLoader from './components/DocLoader'
import { useWalkthrough } from './useWalkthrough'
import { selectorRect } from './components/tokenFlight'
import {
  GA_MEASUREMENT_ID,
  detectGDPRRegion,
  hasConsented,
  setConsent,
  initializeGA4,
} from './analytics'

// EUI's colorblind-safe visualization palette — categorical, and deliberately
// none of them is the teal accent, so a doc chip never reads as UI chrome.
const DOC_COLORS = ['#54b399', '#6092c0', '#d36086', '#9170b8', '#d6bf57', '#e7664c']

export default function App() {
  const {
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
  } = useOpLifecycle(initialCluster)

  const [indexPhase, setIndexPhase] = useState('closed') // overlay choreography phase
  const [docsOpen, setDocsOpen] = useState(false) // document list / delete overlay
  // Open close-ups, innermost last. Nesting is what lets a zoom open a zoom (a
  // shard's local search → one segment's on-disk term dictionary); the shell in
  // src/closeups renders the whole stack and only the top one is interactive.
  const [closeUps, setCloseUps] = useState([]) // [{ kind, ... }] — see closeups/index.js
  const [zoomOrigin, setZoomOrigin] = useState('50% 50%') // transform-origin of the dive

  // Back-compat projections of the stack root, for the scenario snapshot below.
  const rootCloseUp = closeUps[0] ?? null
  const zoomShard = rootCloseUp?.kind === 'shard' ? rootCloseUp.shard : null
  const coordZoom = rootCloseUp?.kind === 'coordinator'

  const [title, setTitle] = useState(PRESETS[0].title)
  const [body, setBody] = useState(PRESETS[0].body)
  const [indexRouting, setIndexRouting] = useState('') // optional _routing at index time
  const [query, setQuery] = useState(EXAMPLE_QUERIES[0])
  const [routing, setRouting] = useState('') // optional _routing on the search

  // Which seeded dataset is seeded, if any. Scenarios read this to detect the
  // load click they scripted and advance rather than stalling. Cleared on Reset.
  const [sampleSet, setSampleSet] = useState(null) // 'sample' | 'routed' | null

  // Analytics (GA4) — banner is only shown to users in GDPR regions
  const [showCookieBanner, setShowCookieBanner] = useState(false)

  const docNum = useRef(1)
  const segNum = useRef(1)

  // Guided scenarios (the intro tour runs on load; the rest are picked from the
  // topbar menu). A scenario only observes this snapshot to decide which step to
  // show and when the user's real action advanced it, and drives the app through
  // the small set of actions below — never doing the thing it is asking for.
  const tour = useWalkthrough(
    {
      indexPhase,
      opType: op?.type ?? null,
      opStep: op ? op.step : -1,
      opDone,
      opQuery: op?.type === 'search' ? op.payload.query : '',
      opRouting: op?.type === 'search' ? op.payload.routing || null : null,
      playing,
      zoomShard,
      coordZoom,
      closeUpKind: closeUps.at(-1)?.kind ?? null,
      closeUpDepth: closeUps.length,
      sampleSet,
    },
    { pause, reset: resetCluster, setQuery, setRouting },
  )

  // Each magnifying glass only lives on the op/step its close-up explains. When
  // the op leaves that phase the whole stack goes, so nothing can linger as a
  // stale overlay (e.g. after Prev/Next, Play advancing, or starting a new op).
  // Only the ROOT is checked — a nested zoom lives and dies with its parent.
  const rootValid = closeUps.length === 0 || closeUpStillValid(op, closeUps[0], extra.search)
  useEffect(() => {
    if (!rootValid) setCloseUps([])
  }, [rootValid])

  // Initialize analytics with GDPR compliance. In GDPR regions we wait for
  // consent (cookie banner); elsewhere we load GA4 immediately. Analytics is
  // skipped entirely in development.
  useEffect(() => {
    const initAnalytics = async () => {
      const measurementId = GA_MEASUREMENT_ID

      // Don't initialize in development or if no measurement ID is set
      if (!measurementId || import.meta.env.DEV) {
        return
      }

      const consent = hasConsented()

      if (consent === 'accepted') {
        // User already accepted - load analytics immediately
        initializeGA4(measurementId)
        return
      }

      if (consent === 'declined') {
        // User already declined - don't show banner or load analytics
        return
      }

      // No consent preference yet - detect GDPR region
      const isGDPR = await detectGDPRRegion()

      if (isGDPR) {
        // User is in GDPR region - show banner
        setShowCookieBanner(true)
      } else {
        // User is not in GDPR region - load analytics immediately
        initializeGA4(measurementId)
      }
    }

    initAnalytics()
  }, [])

  function handleAcceptCookies() {
    setConsent(true)
    setShowCookieBanner(false)
    if (GA_MEASUREMENT_ID && !import.meta.env.DEV) {
      initializeGA4(GA_MEASUREMENT_ID)
    }
  }

  function handleDeclineCookies() {
    setConsent(false)
    setShowCookieBanner(false)
  }

  // Opening a close-up freezes the timeline so auto-play can't advance off the
  // phase the close-up explains while the user is reading it.
  //
  // At depth 0 we also compute the dive's transform-origin — the clicked
  // element's center expressed in % of the .layout box — so the whole view
  // appears to rush toward it (see the .layout motion.div below). The DOM is at
  // rest at click time, so the rects are accurate. Nested opens skip the dive:
  // the page is already scaled out and hidden behind the parent panel, and the
  // child springs out of its anchor inside that panel instead.
  function openCloseUp(cu) {
    if (closeUps.length > 0) {
      setCloseUps((s) => [...s, cu])
      return
    }
    pause()
    const card = selectorRect(closeUpAnchor(cu, extra.search))
    const layout = selectorRect('.layout')
    if (card && layout && layout.width && layout.height) {
      const ox = ((card.left + card.width / 2 - layout.left) / layout.width) * 100
      const oy = ((card.top + card.height / 2 - layout.top) / layout.height) * 100
      setZoomOrigin(`${ox.toFixed(1)}% ${oy.toFixed(1)}%`)
    }
    setCloseUps([cu])
  }

  // Close everything from `depth` up, so a panel's ✕ / backdrop drops back to
  // its parent (and the root's drops back to the cluster).
  const popCloseUp = (depth) => setCloseUps((s) => s.slice(0, depth))

  // The built shell contexts for the open stack. Rebuilt whenever the derived
  // cluster moves so a panel always renders current state.
  const closeUpStack = useMemo(
    () =>
      closeUps
        .map((cu) => buildCloseUp(cu, { op, derived, search: extra.search }))
        .filter(Boolean),
    [closeUps, op, derived, extra.search],
  )

  const hasText = title.trim() || body.trim()
  const canIndex = hasText && canStartNew && !playing

  // Predicted routing + colour for the NEXT document, so the overlay can fly
  // tokens to the correct shard and tint them before the op actually starts.
  // Typing a routing key changes the prediction live — that IS the mechanism.
  const nextShard = routeShard(indexRouting.trim() || `doc-${docNum.current}`)
  const nextColor = DOC_COLORS[(docNum.current - 1) % DOC_COLORS.length]
  const canRefresh = (hasBuffered || hasPendingDelete) && !playing
  const canFlush = hasUncommitted && !playing
  const canMerge = hasMergeable && !playing
  const canSearch = hasSearchable && query.trim() && !playing

  function startIndex() {
    if (!canIndex) return
    const id = `doc-${docNum.current}`
    const color = DOC_COLORS[(docNum.current - 1) % DOC_COLORS.length]
    docNum.current += 1
    const doc = {
      id,
      title: title.trim(),
      body: body.trim(),
      tokens: analyzeDoc({ title: title.trim(), body: body.trim() }),
      deleted: false,
      color,
      routing: indexRouting.trim() || undefined,
      // hash(_routing) when a key was supplied, hash(_id) otherwise.
      shard: docRoute({ id, routing: indexRouting.trim() }),
    }
    start('index', { doc })
  }

  function startRefresh() {
    if (!canRefresh) return
    const newSegments = {}
    base.shards.forEach((s) => {
      if (s.buffer.length > 0) newSegments[s.id] = `seg-${segNum.current++}`
    })
    start('refresh', { newSegments })
  }

  function startFlush() {
    if (!canFlush) return
    start('flush', {})
  }

  function startMerge() {
    if (!canMerge) return
    const newSegments = {}
    base.shards.forEach((s) => {
      if (s.segments.filter((seg) => seg.searchable).length >= 2)
        newSegments[s.id] = `seg-${segNum.current++}`
    })
    start('merge', { newSegments })
  }

  function startSearch() {
    if (!canSearch) return
    start('search', { query: query.trim(), routing: routing.trim() || null })
  }

  // Seed a ready-to-search cluster directly from a list of docs: route each one,
  // then place them into searchable+committed segments (≤2 docs each) grouped by
  // shard. This gives a zoomed shard several docs across multiple segments so the
  // close-up's scoring + priority-queue steps have something to show.
  //
  // `tombstoned` keeps one doc's delete bit set so the close-up's live-docs
  // bitset isn't trivial. It stays a tombstone (not purged), so per the SPEC
  // guardrail it is still searchable until a refresh applies the delete.
  //
  // Deliberately does NOT end a running scenario: the intro scripts a load, and
  // its later steps only need `sampleSet` plus a search, so an off-script load
  // can't strand it either.
  function loadDataset(id) {
    const set = DATASETS.find((d) => d.id === id)
    if (!set) return
    const { docs: source, tombstoned = null, colorBy } = set
    const c = initialCluster()
    const byShard = Object.fromEntries(SHARD_PLACEMENT.map((p) => [p.id, []]))
    source.forEach((d, i) => {
      const id = `doc-${i + 1}`
      const doc = {
        id,
        title: d.title,
        body: d.body,
        tokens: analyzeDoc({ title: d.title, body: d.body }),
        deleted: id === tombstoned,
        color: DOC_COLORS[colorBy(d, i) % DOC_COLORS.length],
        routing: d.routing,
        shard: docRoute({ id, routing: d.routing }),
      }
      c.docs[id] = doc
      byShard[doc.shard].push(id)
    })
    let seg = 1
    for (const shard of c.shards) {
      const ids = byShard[shard.id]
      for (let j = 0; j < ids.length; j += 2)
        shard.segments.push({
          id: `seg-${seg++}`,
          docIds: ids.slice(j, j + 2),
          searchable: true,
          committed: true,
        })
    }
    resetTo(c)
    setIndexPhase('closed')
    setCloseUps([])
    setDocsOpen(false)
    setSampleSet(id)
    docNum.current = source.length + 1
    segNum.current = seg
  }

  // Clear the cluster back to empty. This is what a scenario's setup() calls, so
  // it must NOT end the scenario — the Reset button below does that itself.
  function resetCluster() {
    resetTo(initialCluster())
    setIndexPhase('closed')
    setCloseUps([])
    setDocsOpen(false)
    setSampleSet(null)
    docNum.current = 1
    segNum.current = 1
  }

  function reset() {
    tour.abort() // leaving the scripted path — end the scenario gracefully
    resetCluster()
  }

  const currentStep = op ? stepsFor(op.type)[op.step] : null
  // One extra line about this op's payload (routing target, wildcard cost).
  const note = opNote(op, extra)
  const allDocs = Object.values(derived.docs).sort(
    (a, b) => docOrder(a.id) - docOrder(b.id),
  )

  return (
    <div className="app">
      <div className="topbar">
        <h1>Elasticsearch Cluster Visualizer</h1>
        <span className="sub">
          Routing & replication across a 3-node cluster, the write path, and
          scatter-gather search
        </span>
        <ScenarioPicker
          activeId={tour.id}
          running={tour.status === 'running'}
          onStart={tour.start}
        />
      </div>

      <motion.div
        className="layout"
        style={{ transformOrigin: zoomOrigin }}
        animate={
          closeUps.length > 0 ? { scale: 1.7, opacity: 0 } : { scale: 1, opacity: 1 }
        }
        transition={{ type: 'tween', ease: 'easeInOut', duration: 0.5 }}
      >
        {/* ---------------- Left: controls ---------------- */}
        <div className="col">
          <p className="section-title">Lifecycle</p>
          <div className="btn-grid">
            <button
              className="btn"
              data-tour="refresh"
              onClick={startRefresh}
              disabled={!canRefresh}
            >
              Refresh
            </button>
            <button className="btn" onClick={startFlush} disabled={!canFlush}>
              Flush
            </button>
            <button
              className="btn"
              data-tour="merge"
              onClick={startMerge}
              disabled={!canMerge}
            >
              Merge
            </button>
            <button className="btn" onClick={reset}>
              Reset
            </button>
          </div>

          <p className="section-title" style={{ marginTop: 20 }}>
            Documents
          </p>
          {/* Every control in this column stays mounted whatever the app is
              doing — disabled, never removed. Unmounting one (the index button
              while its overlay is open, the delete button before anything is
              indexed) shifted everything below it by a button's height, and the
              overlay is see-through enough that you watch the column jump. */}
          <button
            className="btn primary block"
            data-tour="index-doc"
            onClick={() => setIndexPhase('editing')}
            disabled={indexPhase !== 'closed' && indexPhase !== 'done'}
          >
            ＋ Index a document
          </button>
          <DocLoader
            loaded={sampleSet}
            required={
              tour.status === 'running' && tour.visible ? tour.step?.dataset ?? null : null
            }
            onLoad={loadDataset}
          />
          <button
            className="btn block"
            style={{ marginTop: 8 }}
            onClick={() => setDocsOpen(true)}
            disabled={allDocs.length === 0}
          >
            Delete a document
          </button>

          <p className="section-title" style={{ marginTop: 20 }}>
            Search
          </p>
          <div data-tour="search-area">
            <div className="search-row">
              <input
                type="text"
                data-search-source
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="search terms…"
              />
              <button className="btn primary" onClick={startSearch} disabled={!canSearch}>
                Search
              </button>
            </div>
            <div className="presets">
              {EXAMPLE_QUERIES.map((q) => (
                <button key={q} className="preset-chip" onClick={() => setQuery(q)}>
                  {q}
                </button>
              ))}
              {WILDCARD_QUERIES.map((q) => (
                <button
                  key={q}
                  className="preset-chip wildcard"
                  title="wildcard pattern — resolved against each segment's term dictionary"
                  onClick={() => setQuery(q)}
                >
                  {q}
                </button>
              ))}
            </div>

            {/* Optional _routing on the query: hash this instead of scattering. */}
            <div className="routing-row">
              <label className="routing-label">routing key</label>
              <input
                type="text"
                value={routing}
                onChange={(e) => setRouting(e.target.value)}
                placeholder="none — ask every shard"
              />
            </div>
          </div>
        </div>

        {/* ---------------- Center: cluster ---------------- */}
        <div className="col" data-tour="cluster">
          <p className="section-title">Cluster</p>
          <ClusterStage
            cluster={derived}
            extra={extra}
            op={op}
            onZoom={(id) => openCloseUp({ kind: 'shard', shard: id })}
            onCoordZoom={() => openCloseUp({ kind: 'coordinator' })}
          />
        </div>

        {/* ---------------- Right: explain + inspector ---------------- */}
        <div className="col">
          <p className="section-title">What's happening</p>
          {currentStep ? (
            <div className="explain">
              <h3>{currentStep.title}</h3>
              <p>{currentStep.blurb}</p>
              {note && <p className="explain-note">{note}</p>}
            </div>
          ) : (
            // The idle panel is also what you land on after a Reset or a dataset
            // load, so it says what to do NEXT from where you actually are
            // rather than always describing an empty cluster.
            <div className="explain idle">
              <h3>Ready</h3>
              <p>
                {allDocs.length === 0
                  ? 'Nothing indexed yet. Use ＋ Index a document to walk one document through the write path, or Load docs to fill the cluster and go straight to a search.'
                  : 'Run a Search, or use Refresh / Flush / Merge to move these documents through the rest of the lifecycle. Every operation replays step by step in the footer.'}
              </p>
            </div>
          )}

          {op?.type === 'search' ? (
            <SearchResultsPanel
              search={extra.search}
              step={op.step}
              docs={derived.docs}
            />
          ) : (
            <InvertedIndexTable cluster={derived} />
          )}
        </div>
      </motion.div>

      {/* ---------------- Bottom: stepper ---------------- */}
      <Stepper
        dataTour="stepper"
        steps={op ? stepsFor(op.type) : []}
        step={op ? op.step : -1}
        opLabel={op ? OP_LABELS[op.type] : ''}
        playing={playing}
        onPrev={() => step(-1)}
        onNext={() => step(1)}
        onPlay={play}
        onPause={pause}
        highlightPlay={tour.status === 'running' && !!tour.step?.highlightPlay}
      />

      {/* ---------------- Overlay: indexing experience ---------------- */}
      <IndexOverlay
        presets={PRESETS}
        title={title}
        body={body}
        setTitle={setTitle}
        setBody={setBody}
        routing={indexRouting}
        setRouting={setIndexRouting}
        canIndex={canIndex}
        targetShard={nextShard}
        docColor={nextColor}
        onIndex={startIndex}
        op={op}
        playing={playing}
        phase={indexPhase}
        setPhase={setIndexPhase}
      />

      {/* ---------------- Overlay: the document list (delete / undo) ---------------- */}
      <DeleteDocOverlay
        open={docsOpen}
        docs={allDocs}
        onToggleDelete={toggleDelete}
        onClose={() => setDocsOpen(false)}
      />

      {/* ---------------- Overlay: search scatter-gather flights ---------------- */}
      <SearchFlight op={op} search={extra.search} docs={derived.docs} />

      {/* ---------------- Overlay: the close-up stack (shard, coordinator, on-disk) ---------------- */}
      <CloseUp
        stack={closeUpStack}
        onPop={popCloseUp}
        openCloseUp={openCloseUp}
        highlightClose={tour.status === 'running'}
      />

      {/* ---------------- Cookie consent (GDPR regions only) ---------------- */}
      {showCookieBanner && (
        <CookieBanner
          onAccept={handleAcceptCookies}
          onDecline={handleDeclineCookies}
        />
      )}

      {/* ---------------- Overlay: guided scenario ---------------- */}
      <Walkthrough tour={tour} allowEscape={closeUps.length === 0} />
    </div>
  )
}

function docOrder(id) {
  const n = parseInt(id.replace(/\D/g, ''), 10)
  return Number.isNaN(n) ? 0 : n
}
