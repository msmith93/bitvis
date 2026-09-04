import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { analyzeDoc } from './analyzer'
import {
  PRESETS,
  EXAMPLE_QUERIES,
  WILDCARD_QUERIES,
  FUZZY_QUERIES,
  NESTED_QUERIES,
  DATASETS,
} from './presets'
import { buildBlock, makeMapping } from './mapping'
import {
  docRoute,
  initialCluster,
  isRootDoc,
  routeShard,
  shardWillMerge,
  SHARD_PLACEMENT,
} from './cluster'
import { lastStep, OP_LABELS, opNote, stepsFor } from './ops'
import { useOpLifecycle } from './useOpLifecycle'
import ClusterStage from './components/ClusterStage'
import IndexOverlay from './components/IndexOverlay'
import InvertedIndexTable from './components/InvertedIndexTable'
import SearchFlight from './components/SearchFlight'
import SearchResultsPanel from './components/SearchResultsPanel'
import SearchResultsOverlay from './components/SearchResultsOverlay'
import { CloseUp, buildCloseUp, closeUpAnchor, closeUpStillValid } from './closeups'
import DeleteDocOverlay from './components/DeleteDocOverlay'
import Stepper from './components/Stepper'
import CookieBanner from './components/CookieBanner'
import HomeLink from './components/HomeLink'
import MobileWarning from './components/MobileWarning'
import Walkthrough from './components/Walkthrough'
import ScenarioPicker from './components/ScenarioPicker'
import ThemeToggle from './components/ThemeToggle'
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
    start,
    step,
    play,
    pause,
    toggleDelete,
    resetTo,
  } = useOpLifecycle(initialCluster)

  const [indexPhase, setIndexPhase] = useState('closed') // overlay choreography phase
  const [docsOpen, setDocsOpen] = useState(false) // document list / delete overlay
  // The full-response dialog: 'idle' (nothing pending), 'pending' (a search is
  // running and will pop it open the moment it completes), 'open' (showing).
  // Closing sets 'idle' rather than back to 'pending', so parking on the last
  // step (or revisiting it) never reopens it — only a NEW search does.
  const [resultsPhase, setResultsPhase] = useState('idle')
  // Open close-ups, innermost last. Nesting is what lets a zoom open a zoom (a
  // shard's local search → one segment's on-disk term dictionary); the shell in
  // src/closeups renders the whole stack and only the top one is interactive.
  const [closeUps, setCloseUps] = useState([]) // [{ kind, ... }] — see closeups/index.js
  const [zoomOrigin, setZoomOrigin] = useState('50% 50%') // transform-origin of the dive

  // Back-compat projections of the stack root, for the scenario snapshot below.
  const rootCloseUp = closeUps[0] ?? null
  const zoomShard = rootCloseUp?.kind === 'shard' ? rootCloseUp.shard : null
  const coordZoom = rootCloseUp?.kind === 'coordinator'

  // Where the innermost close-up's own mini-stepper has got to, reported up by
  // CloseUp. A tour step needs this to wait for a beat INSIDE a panel — the
  // fuzzy walk only reaches an accepting state on the panel's last step, and
  // without this the tour cannot know when to point at it.
  // Bumped by a tour tip's own "next step" button; CloseUp watches the counter
  // and walks the active panel forward one unit per press.
  const [panelAdvance, setPanelAdvance] = useState(0)
  const advancePanel = useCallback(() => setPanelAdvance((n) => n + 1), [])

  const [panelStep, setPanelStep] = useState({ step: 0, last: 0, sub: null, units: 1 })
  const onPanelStep = useCallback(
    (step, last, sub, units) =>
      setPanelStep((p) =>
        p.step === step && p.last === last && p.sub === sub && p.units === units
          ? p
          : { step, last, sub, units },
      ),
    [],
  )

  const [title, setTitle] = useState(PRESETS[0].title)
  const [body, setBody] = useState(PRESETS[0].body)
  const [indexRouting, setIndexRouting] = useState('') // optional _routing at index time
  // The "advanced" half of the index form: an array of sub-objects under the
  // `variants` path, and whether that path is mapped `nested` or left as the
  // default `object`. Empty means an ordinary two-field document, which is what
  // the form has always produced.
  const [variants, setVariants] = useState([])
  const [nestedPath, setNestedPath] = useState(false)
  const [query, setQuery] = useState(EXAMPLE_QUERIES[0])
  const [routing, setRouting] = useState('') // optional _routing on the search

  // Which seeded dataset is seeded, if any. Scenarios read this to detect the
  // load click they scripted and advance rather than stalling. Cleared on Reset.
  const [sampleSet, setSampleSet] = useState(null) // 'sample' | 'routed' | null

  // Whether the topbar Scenarios menu is open. Lives here (rather than only in
  // ScenarioPicker) because the intro tour's last step waits on the real click
  // that opens it.
  const [scenariosOpen, setScenariosOpen] = useState(false)

  // Analytics (GA4) — banner is only shown to users in GDPR regions
  const [showCookieBanner, setShowCookieBanner] = useState(false)

  const docNum = useRef(1)
  const segNum = useRef(1)

  // The source document the index form currently describes. Shared by the form's
  // live preview and by startIndex, so the "writes N Lucene docs" readout can
  // never disagree with what actually gets written.
  const indexSource = (t, b, vs) => ({
    title: t.trim(),
    body: b.trim(),
    ...(vs.length ? { variants: vs.map((v) => ({ ...v })) } : {}),
  })

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
      closeUpStep: closeUps.length ? panelStep.step : -1,
      closeUpLast: closeUps.length ? panelStep.last : -1,
      // How far into the current step's own replay the reader has scrubbed
      // (0 when they have just entered it manually, null while the stage's
      // clock owns it). -1 when no close-up is open.
      closeUpSub: closeUps.length ? panelStep.sub ?? -1 : -1,
      closeUpUnits: closeUps.length ? panelStep.units : -1,
      sampleSet,
      scenariosOpen,
      docsOpen,
      resultsOpen: resultsPhase === 'open',
      // What the index form is currently set up to write: how many sub-objects,
      // and whether their path is mapped nested. A scenario step waits on these
      // to know the reader indexed the document it prefilled.
      indexVariants: variants.length,
      indexNested: nestedPath,
      // How many LUCENE docs currently carry a tombstone. On a flat dataset this
      // is the number of documents deleted; on a nested one it is that number
      // times the block size, which is exactly what update amplification is.
      tombstoned: Object.values(derived.docs).filter((d) => d.deleted).length,
    },
    {
      pause,
      reset: resetCluster,
      setQuery,
      setRouting,
      // Prefill the index form — including the advanced sub-objects and the
      // mapping. A scenario step may set this up but must still ask the reader
      // to press Index themselves.
      setIndexDoc: ({ title: t, body: b, variants: vs = [], nested = false }) => {
        setTitle(t)
        setBody(b)
        setVariants(vs)
        setNestedPath(nested)
      },
    },
  )

  // Each magnifying glass only lives on the op/step its close-up explains. When
  // the op leaves that phase the whole stack goes, so nothing can linger as a
  // stale overlay (e.g. after Prev/Next, Play advancing, or starting a new op).
  // Only the ROOT is checked — a nested zoom lives and dies with its parent.
  const rootValid = closeUps.length === 0 || closeUpStillValid(op, closeUps[0], extra.search)
  useEffect(() => {
    if (!rootValid) setCloseUps([])
  }, [rootValid])

  // Pop the full-response dialog the instant a search reaches the same
  // "actually finished" moment the footer stepper's own dwell logic uses —
  // last step, auto-play stopped. Gated on 'pending' (set by startSearch) so
  // parking on that step, or scrubbing back to it, never reopens a dialog the
  // reader already closed.
  useEffect(() => {
    if (
      resultsPhase === 'pending' &&
      op?.type === 'search' &&
      op.step >= lastStep('search') &&
      !playing
    ) {
      setResultsPhase('open')
    }
  }, [resultsPhase, op, playing])

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
  // Deliberately NOT gated on there being anything searchable: running a query
  // against an empty (or entirely un-refreshed) index is one of the things this
  // app is for — the scatter still happens, every shard reports "no local hits",
  // and the reader sees that buffered documents really are invisible to search.
  // `canStartNew` is named explicitly here because it used to ride in on
  // `hasSearchable` (which is false whenever `base` is null, i.e. mid-op); drop
  // it and the button would arm while an op is paused, and `start()` would
  // commit a null cluster.
  const canSearch = canStartNew && query.trim() && !playing

  function startIndex() {
    if (!canIndex) return
    const id = `doc-${docNum.current}`
    const color = DOC_COLORS[(docNum.current - 1) % DOC_COLORS.length]
    docNum.current += 1
    // Whatever the form describes: two text fields, plus any sub-objects the
    // advanced section added, under the mapping it chose. One builder for every
    // shape, so the write path has exactly one notion of what indexing produces.
    const block = buildBlock(
      indexSource(title, body, variants),
      {
        id,
        mapping: makeMapping(nestedPath ? ['variants'] : []),
        deleted: false,
        color,
        routing: indexRouting.trim() || undefined,
        // hash(_routing) when a key was supplied, hash(_id) otherwise.
        shard: docRoute({ id, routing: indexRouting.trim() }),
      },
    )
    start('index', { doc: block[block.length - 1], block })
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
      if (shardWillMerge(s, base.docs)) newSegments[s.id] = `seg-${segNum.current++}`
    })
    start('merge', { newSegments })
  }

  function startSearch() {
    if (!canSearch) return
    setResultsPhase('pending')
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
    const { docs: source, tombstoned = null, colorBy, mapping = [] } = set
    const m = makeMapping(mapping)
    const c = initialCluster()
    // Blocks, not ids: each source document expands into its Lucene docs
    // (children first, root last) and they must stay together and in order.
    const byShard = Object.fromEntries(SHARD_PLACEMENT.map((p) => [p.id, []]))
    source.forEach((d, i) => {
      const id = `doc-${i + 1}`
      // `routing` is request metadata, not a field — it must never be indexed.
      const { routing, ...fields } = d
      const block = buildBlock(fields, {
        id,
        mapping: m,
        deleted: id === tombstoned,
        color: DOC_COLORS[colorBy(d, i) % DOC_COLORS.length],
        routing,
        shard: docRoute({ id, routing }),
      })
      for (const ld of block) c.docs[ld.id] = ld
      byShard[block[0].shard].push(block)
    })
    let seg = 1
    for (const shard of c.shards) {
      const blocks = byShard[shard.id]
      // Aim for ~3 segments per shard whatever the dataset's size, so a bigger
      // set doesn't turn a shard card into a stack of a dozen slivers. Counted
      // in DOCUMENTS rather than Lucene docs, so the nested catalog segments the
      // same way its object twin does — the difference between them should be
      // the size of a segment, not the number of them. The shipped text sets are
      // unchanged by this (their blocks are all length 1).
      const per = Math.max(2, Math.ceil(blocks.length / 3))
      for (let j = 0; j < blocks.length; j += per)
        shard.segments.push({
          id: `seg-${seg++}`,
          docIds: blocks.slice(j, j + per).flatMap((b) => b.map((ld) => ld.id)),
          searchable: true,
          committed: true,
        })
    }
    resetTo(c)
    setIndexPhase('closed')
    setCloseUps([])
    setDocsOpen(false)
    setResultsPhase('idle')
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
    setResultsPhase('idle')
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
  // The ELASTICSEARCH documents — block roots only. The children are Lucene's
  // business: you never delete or address one on its own, so the document list
  // must not offer to.
  const allDocs = Object.values(derived.docs)
    .filter(isRootDoc)
    .sort((a, b) => docOrder(a.id) - docOrder(b.id))

  return (
    <div className="app">
      <div className="topbar">
        <HomeLink />
        <h1>Elasticsearch Cluster Visualizer</h1>
        <span className="sub">
          Visualizing a 3-shard (1-replica) index on a 3-node ElasticSearch cluster
        </span>
        <ScenarioPicker
          activeId={tour.id}
          running={tour.status === 'running'}
          onStart={tour.start}
          onOpenChange={setScenariosOpen}
        />
        <ThemeToggle />
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
            data-tour="delete-doc"
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
              {FUZZY_QUERIES.map((q) => (
                <button
                  key={q}
                  className="preset-chip fuzzy"
                  title="fuzzy pattern — matched by edit distance against each segment's term dictionary"
                  onClick={() => setQuery(q)}
                >
                  {q}
                </button>
              ))}
              {/* Field-qualified + conjunctive. Only meaningful on a dataset that
                  HAS those fields, so they only appear once one is loaded. */}
              {sampleSet?.startsWith('catalog') &&
                NESTED_QUERIES.map((q) => (
                  <button
                    key={q}
                    className="preset-chip nested"
                    title="field-qualified clauses, ANDed — every clause must match the same Lucene document"
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
        variants={variants}
        setVariants={setVariants}
        nestedPath={nestedPath}
        setNestedPath={setNestedPath}
        source={indexSource(title, body, variants)}
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

      {/* ---------------- Overlay: the full response, once a search completes ---------------- */}
      <SearchResultsOverlay
        open={resultsPhase === 'open'}
        query={op?.type === 'search' ? op.payload.query : ''}
        search={extra.search}
        docs={derived.docs}
        onClose={() => setResultsPhase('idle')}
      />

      {/* ---------------- Overlay: the close-up stack (shard, coordinator, on-disk) ---------------- */}
      <CloseUp
        stack={closeUpStack}
        onPop={popCloseUp}
        openCloseUp={openCloseUp}
        highlightClose={tour.status === 'running'}
        // A tour step that only asks to be READ (a cta, nothing to advance on)
        // freezes the panel's auto-play, so the walk it is describing does not
        // play out behind the tooltip while the user is still reading.
        // `holdPanel` freezes it for a step that DOES advance on something —
        // the ones that hand the replay to the reader and wait for them to
        // walk it with Next, where an auto-play clock would race them.
        held={
          tour.visible &&
          (!!tour.step?.holdPanel || (!!tour.step?.cta && !tour.step?.advanceOn))
        }
        // Any read-this tip means "stay and look at this" — so the panel must
        // not simultaneously be inviting the reader to close it.
        quiet={tour.visible && !!tour.step?.cta}
        onPanelStep={onPanelStep}
        advance={panelAdvance}
      />

      {/* ---------------- Cookie consent (GDPR regions only) ---------------- */}
      {showCookieBanner && (
        <CookieBanner
          onAccept={handleAcceptCookies}
          onDecline={handleDeclineCookies}
        />
      )}

      {/* ---------------- Overlay: guided scenario ---------------- */}
      <Walkthrough
        tour={tour}
        allowEscape={closeUps.length === 0}
        onPanelNext={advancePanel}
        // What the panel is doing at THIS unit of its replay, so a guided step
        // can say why the walk went the way it did instead of narrating the
        // walk in general. Derived by the close-up from its own trace.
        narration={
          closeUpStack.at(-1)?.narrate?.(panelStep.step, panelStep.sub) ?? null
        }
        // "3 / 33" beside the tip's own next button, so the reader can see how
        // far through the replay they are without looking away from it.
        panelProgress={
          closeUps.length && panelStep.units > 1
            ? `${Math.min(panelStep.sub ?? panelStep.units, panelStep.units)} / ${panelStep.units}`
            : null
        }
      />

      {/* ---------------- Overlay: "this is a desktop simulation" ---------------- */}
      <MobileWarning />
    </div>
  )
}

function docOrder(id) {
  const n = parseInt(id.replace(/\D/g, ''), 10)
  return Number.isNaN(n) ? 0 : n
}
