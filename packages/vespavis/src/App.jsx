import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  CATEGORIES,
  CORPUS,
  DEFAULT_SCHEMA_CONFIG,
  NEW_DOCS,
  UPDATE_FIELDS,
  USERS,
  makeDoc,
  nudgeProfile,
} from './schema'
import { modesFor, MODES } from './ranking'
import { activeNodeFor, initialCluster, nodeWillFlush, nodeWillFuse, seedCluster } from './cluster'
import { FLUSH_MAXMEMORYGAIN } from './constants'
import { OP_LABELS, opNote, stepsOf } from './ops'
import { useOpLifecycle } from './useOpLifecycle'
import ClusterStage from './components/ClusterStage'
import Stepper from './components/Stepper'
import SchemaPanel from './components/SchemaPanel'
import ResultsPanel from './components/ResultsPanel'
import VectorSpace from './components/VectorSpace'
import Flights from './components/Flights'
import CookieBanner from './components/CookieBanner'
import HomeLink from './components/HomeLink'
import MobileWarning from './components/MobileWarning'
import {
  GA_MEASUREMENT_ID,
  detectGDPRRegion,
  hasConsented,
  setConsent,
  initializeGA4,
} from './analytics'

// The example queries, chosen so the three retrieval modes visibly disagree.
// `waterproof jacket` is the one to run in every mode: BM25 puts a bluetooth
// speaker second, the vector search finds a windbreaker that contains neither
// word, and hybrid is the only one that gets both right.
const EXAMPLES = {
  lexical: ['waterproof jacket', 'wireless audio', 'cast iron'],
  semantic: [
    'something to keep me dry in the rain',
    'gear for a cold hike',
    'making coffee at home',
  ],
  hybrid: ['waterproof jacket', 'warm layer for winter', 'shoes for wet trails'],
  filtered: ['waterproof jacket', 'something warm'],
}

const USE_CASES = [
  { id: 'search', label: 'Product search' },
  { id: 'recommend', label: 'Recommendation' },
]

export default function App() {
  const {
    op,
    opDone,
    playing,
    derived,
    extra,
    base,
    canStartNew,
    hasDocs,
    hasFusable,
    start,
    step,
    play,
    pause,
    resetTo,
  } = useOpLifecycle(() => seedCluster(CORPUS, USERS))

  const [useCase, setUseCase] = useState('search')
  const [mode, setMode] = useState('hybrid')
  const [text, setText] = useState('waterproof jacket')
  const [category, setCategory] = useState('outerwear')
  const [userName, setUserName] = useState(USERS[0].user_id)
  const [target, setTarget] = useState(null) // doc id for update / remove
  const [updateField, setUpdateField] = useState('popularity')
  const [config, setConfig] = useState(DEFAULT_SCHEMA_CONFIG)
  const [panelTab, setPanelTab] = useState('schema')
  const [schemaTab, setSchemaTab] = useState('schema')
  const [showCookieBanner, setShowCookieBanner] = useState(false)

  const feedIdx = useRef(0)
  const flushIdx = useRef(3)
  const fusionIdx = useRef(1)

  const products = useMemo(
    () =>
      Object.values(derived.docs)
        .filter((d) => d.type === 'product' && !d.removed)
        .sort((a, b) => a.n - b.n),
    [derived.docs],
  )
  const docCount = products.length
  const user = useMemo(
    () => Object.values(derived.docs).find((d) => d.type === 'user' && d.user_id === userName),
    [derived.docs, userName],
  )

  const m = MODES[mode]
  const busy = !canStartNew || playing
  const canQuery = !busy && (m.usesText ? text.trim().length > 0 : true)
  const targetDoc = target ? derived.docs[target] : null

  // Switching use case switches the query it makes sense to run.
  function pickUseCase(id) {
    setUseCase(id)
    const first = modesFor(id)[0]
    if (first && MODES[mode]?.useCase !== id) setMode(first.id)
    setPanelTab(id === 'recommend' ? 'vectors' : 'results')
  }

  const startQuery = useCallback(
    (over = {}) => {
      const mm = MODES[over.mode ?? mode]
      start('query', {
        mode: over.mode ?? mode,
        text: text.trim(),
        category,
        config,
        userProfile: mm.usesProfile ? over.userProfile ?? user?.profile ?? null : null,
        userName: mm.usesProfile ? userName : null,
      })
    },
    [mode, text, category, config, user, userName, start],
  )

  useEffect(() => {
    if (op?.type === 'query') setPanelTab((t) => (t === 'schema' ? 'results' : t))
  }, [op?.type, op?.payload])

  useEffect(() => {
    if (target && !derived.docs[target]) setTarget(null)
  }, [target, derived.docs])

  // Proton's flush engine, as a rule rather than a button.
  //
  // A flush is not an API call in Vespa — the flush engine runs one when the
  // memory index has grown past the budget in the flush strategy. So the app
  // watches the same threshold and starts the op ITSELF. Nothing the reader can
  // press causes this, which is exactly the point; the gauge on each node card
  // is what tells them it is coming.
  useEffect(() => {
    if (!canStartNew || playing || !base) return
    const over = base.nodes.some(
      (n) => nodeWillFlush(n) && n.memoryIndex.length >= FLUSH_MAXMEMORYGAIN,
    )
    if (!over) return
    const newIndexes = {}
    for (const n of base.nodes) newIndexes[n.id] = `index.flush.${flushIdx.current}`
    flushIdx.current += 1
    start('flush', { newIndexes, auto: true })
  }, [base, canStartNew, playing, start])

  useEffect(() => {
    const init = async () => {
      const id = GA_MEASUREMENT_ID
      if (!id || import.meta.env.DEV) return
      const consent = hasConsented()
      if (consent === 'accepted') return initializeGA4(id)
      if (consent === 'declined') return
      if (await detectGDPRRegion()) setShowCookieBanner(true)
      else initializeGA4(id)
    }
    init()
  }, [])

  function startFeed() {
    if (busy) return
    const src = NEW_DOCS[feedIdx.current % NEW_DOCS.length]
    feedIdx.current += 1
    const n =
      Math.max(0, ...Object.values(base.docs).filter((d) => d.type === 'product').map((d) => d.n)) + 1
    start('feed', { doc: makeDoc(src, n) })
  }

  function startUpdate() {
    if (busy || !targetDoc) return
    const f = UPDATE_FIELDS[updateField]
    if (f.kind === 'index') {
      start('update', {
        id: targetDoc.id,
        docType: 'product',
        field: 'title',
        kind: 'index',
        from: targetDoc.title,
        value: `${targetDoc.title} (2024)`,
      })
      return
    }
    const next = Math.round(Math.min(0.99, targetDoc.popularity + 0.25) * 100) / 100
    start('update', {
      id: targetDoc.id,
      docType: 'product',
      field: 'popularity',
      kind: 'attribute',
      from: targetDoc.popularity,
      value: next,
    })
  }

  function startRemove() {
    if (busy || !targetDoc) return
    start('remove', { id: targetDoc.id })
  }

  // Engaging with a recommendation: one partial update to one tensor attribute
  // on one user document. No product is touched, no index is rewritten, and no
  // HNSW graph is repaired — the user's profile has no graph, because nothing
  // ever nearest-neighbour-searches users.
  function engage(doc) {
    if (busy || !user || !doc.embedding) return
    // The payoff of engaging is the profile arrow MOVING, so put the reader in
    // front of it. Leaving them on the results tab hands them an empty panel —
    // an update is not a query, so there are no results to show — and hides the
    // one thing the interaction exists to demonstrate.
    setPanelTab('vectors')
    start('update', {
      id: user.id,
      docType: 'user',
      userName: user.user_id,
      field: 'profile',
      kind: 'attribute',
      from: user.profile,
      value: nudgeProfile(user.profile, doc.embedding),
      engagedWith: doc.title,
    })
  }

  function startFusion() {
    if (busy || !hasFusable) return
    const newIndexes = {}
    for (const n of base.nodes) newIndexes[n.id] = `index.fusion.${fusionIdx.current}`
    fusionIdx.current += 1
    start('fusion', { newIndexes })
  }

  function reset() {
    resetTo(seedCluster(CORPUS, USERS))
    feedIdx.current = 0
    flushIdx.current = 3
    fusionIdx.current = 1
    setTarget(null)
    setConfig(DEFAULT_SCHEMA_CONFIG)
  }

  const steps = stepsOf(op)
  const currentStep = op ? steps[op.step] : null
  const note = opNote(op, extra)
  const search = extra.search
  const modes = modesFor(useCase)

  // Which node the container will fetch the user document from — the active
  // replica of its bucket, nothing more.
  const stageExtra = useMemo(
    () => ({
      ...extra,
      userNode: user ? activeNodeFor(user.id) : null,
      userName,
    }),
    [extra, user, userName],
  )

  return (
    <div className="app">
      <div className="topbar">
        <HomeLink />
        <h1>Vespa Serving Visualizer</h1>
        <span className="sub">
          Retrieval, ranking and real-time updates in one engine — a stateless
          container cluster over a 4-node content cluster
        </span>
      </div>

      <div className="layout">
        {/* ---------------- Left: controls ---------------- */}
        <div className="col">
          <p className="section-title">Use case</p>
          <div className="usecase-grid">
            {USE_CASES.map((u) => (
              <button
                key={u.id}
                className={'usecase-chip' + (useCase === u.id ? ' on' : '')}
                onClick={() => pickUseCase(u.id)}
              >
                {u.label}
              </button>
            ))}
          </div>

          <p className="section-title">Query</p>
          <div className="mode-grid">
            {modes.map((x) => (
              <button
                key={x.id}
                className={'mode-chip' + (mode === x.id ? ' on' : '')}
                onClick={() => {
                  setMode(x.id)
                  const ex = EXAMPLES[x.id]
                  if (ex && !ex.includes(text)) setText(ex[0])
                }}
                title={x.blurb}
              >
                <b>{x.label}</b>
                <i>{x.short}</i>
              </button>
            ))}
          </div>

          {m.usesProfile ? (
            <>
              <div className="user-pick">
                {USERS.map((u) => (
                  <button
                    key={u.user_id}
                    className={'preset-chip' + (userName === u.user_id ? ' on' : '')}
                    onClick={() => setUserName(u.user_id)}
                    title={u.note}
                  >
                    @{u.user_id}
                  </button>
                ))}
              </div>
              <button
                className="btn primary block"
                onClick={() => startQuery()}
                disabled={busy}
              >
                Recommend for @{userName}
              </button>
              <p className="hint tight">
                No text, no embedding model. The container reads{' '}
                <code>@{userName}</code>’s profile tensor out of a user document
                and searches with it.
              </p>
            </>
          ) : (
            <>
              <div className="search-row">
                <input
                  type="text"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="query…"
                  onKeyDown={(e) => e.key === 'Enter' && startQuery()}
                />
                <button
                  className="btn primary"
                  onClick={() => startQuery()}
                  disabled={!canQuery}
                >
                  Query
                </button>
              </div>
              <div className="presets">
                {(EXAMPLES[mode] || []).map((q) => (
                  <button key={q} className="preset-chip" onClick={() => setText(q)}>
                    {q}
                  </button>
                ))}
              </div>
              {m.usesFilter && (
                <div className="filter-row">
                  <label>category contains</label>
                  <select value={category} onChange={(e) => setCategory(e.target.value)}>
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </>
          )}

          <p className="section-title">Documents</p>
          <button className="btn primary block" onClick={startFeed} disabled={busy}>
            ＋ Feed a document
          </button>

          <div className="target-chips">
            {products.map((d) => (
              <button
                key={d.id}
                className={'target-chip' + (target === d.id ? ' on' : '')}
                onClick={() => setTarget(target === d.id ? null : d.id)}
                title={d.title}
              >
                <span className="tc-dot" style={{ background: d.color }} />#{d.n}
              </button>
            ))}
          </div>

          {/* WHICH FIELD decides what an update costs, so the choice sits with
              the update rather than in the schema panel. */}
          <div className="field-pick">
            {Object.values(UPDATE_FIELDS).map((f) => (
              <button
                key={f.field}
                className={'field-chip' + (updateField === f.field ? ' on' : '')}
                onClick={() => setUpdateField(f.field)}
              >
                <b>{f.label}</b>
                <i>{f.sub}</i>
              </button>
            ))}
          </div>

          <div className="btn-grid">
            <button className="btn" onClick={startUpdate} disabled={busy || !targetDoc}>
              Update
            </button>
            <button className="btn" onClick={startRemove} disabled={busy || !targetDoc}>
              Remove
            </button>
          </div>
          {targetDoc && (
            <p className="hint tight">
              Update <b>#{targetDoc.n}</b> {targetDoc.title} —{' '}
              {updateField === 'popularity'
                ? 'an attribute, assigned in place. Nothing is re-indexed.'
                : 'an index field, so the document is read off disk, re-indexed and written back.'}
            </p>
          )}

          <p className="section-title">Maintenance</p>
          <p className="hint tight">
            Proton runs these itself. A flush fires when a node’s memory index
            passes <code>maxmemorygain</code> ({FLUSH_MAXMEMORYGAIN} documents
            here) — watch the gauge on each node fill as you feed. Neither
            changes what a query can find.
          </p>
          <div className="btn-grid">
            <button className="btn" onClick={startFusion} disabled={busy || !hasFusable}>
              Force fusion
            </button>
            <button className="btn" onClick={reset} disabled={playing}>
              Reset
            </button>
          </div>
        </div>

        {/* ---------------- Centre: the cluster ---------------- */}
        <div className="col stage-col">
          <p className="section-title">
            Cluster <span className="doc-count">{docCount} products · {USERS.length} users</span>
          </p>
          <ClusterStage cluster={derived} extra={stageExtra} op={op} />
        </div>

        {/* ---------------- Right: explain + panels ---------------- */}
        <div className="col">
          <p className="section-title">What's happening</p>
          {currentStep ? (
            <motion.div
              key={currentStep.key}
              className="explain"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
            >
              <h3>{currentStep.title}</h3>
              <p>{currentStep.blurb}</p>
              {note && <p className="explain-note">{note}</p>}
            </motion.div>
          ) : (
            <div className="explain idle">
              <h3>Ready</h3>
              <p>
                {hasDocs
                  ? useCase === 'recommend'
                    ? 'Recommend for a user, then engage with one of the results and recommend again — the profile tensor moves and the answers move with it, with nothing re-indexed in between.'
                    : 'Run a query in any of the four modes and watch each content node’s funnel narrow phase by phase. Tune the rank profile in the application-package panel and run it again.'
                  : 'The cluster is empty. Feed a document to walk one from an HTTP request to being queryable — which, in Vespa, is the same moment.'}
              </p>
            </div>
          )}

          <div className="tabs">
            <button
              className={'tab' + (panelTab === 'results' ? ' on' : '')}
              onClick={() => setPanelTab('results')}
              disabled={!search}
            >
              results
            </button>
            <button
              className={'tab' + (panelTab === 'vectors' ? ' on' : '')}
              onClick={() => setPanelTab('vectors')}
            >
              vector space
            </button>
            <button
              className={'tab' + (panelTab === 'schema' ? ' on' : '')}
              onClick={() => setPanelTab('schema')}
            >
              application package
            </button>
          </div>

          {panelTab === 'results' && search ? (
            <ResultsPanel
              search={search}
              at={extra.at || {}}
              docs={derived.docs}
              onEngage={
                MODES[search.mode]?.usesProfile && !busy ? engage : null
              }
            />
          ) : panelTab === 'vectors' ? (
            <VectorSpace
              docs={derived.docs}
              search={search}
              profile={useCase === 'recommend' ? user?.profile : null}
              profileLabel={userName}
              targetHits={config.targetHits}
            />
          ) : (
            <SchemaPanel
              mode={mode}
              useCase={useCase}
              tab={schemaTab}
              setTab={setSchemaTab}
              config={config}
              setConfig={setConfig}
            />
          )}
        </div>
      </div>

      <Stepper
        steps={steps}
        step={op ? op.step : -1}
        opLabel={op ? OP_LABELS[op.type] : ''}
        playing={playing}
        onPrev={() => step(-1)}
        onNext={() => step(1)}
        onPlay={play}
        onPause={pause}
      />

      <Flights op={op} extra={stageExtra} />

      {showCookieBanner && (
        <CookieBanner
          onAccept={() => {
            setConsent(true)
            setShowCookieBanner(false)
            if (GA_MEASUREMENT_ID && !import.meta.env.DEV) initializeGA4(GA_MEASUREMENT_ID)
          }}
          onDecline={() => {
            setConsent(false)
            setShowCookieBanner(false)
          }}
        />
      )}

      <MobileWarning />
    </div>
  )
}
