import { useEffect, useRef, useState } from 'react'
import {
  initialCluster,
  replicaWalk,
  nodeEntryFor,
  COORDINATOR,
  CL,
  N_REPLICAS,
  NODE_COLORS,
} from './cluster'
import { OP_LABELS, stepsFor } from './ops'
import { useOpLifecycle } from './useOpLifecycle'
import ClusterStage from './components/ClusterStage'
import ChipFlight from './components/ChipFlight'
import ConsistencyPicker from './components/ConsistencyPicker'
import QuorumPanel from './components/QuorumPanel'
import MerkleView from './components/MerkleView'
import NodeInspector from './components/NodeInspector'
import ScenarioBar from './components/ScenarioBar'
import Stepper from './components/Stepper'
import CookieBanner from './components/CookieBanner'
import Walkthrough from './components/Walkthrough'
import { useWalkthrough } from './useWalkthrough'
import {
  GA_MEASUREMENT_ID,
  detectGDPRRegion,
  hasConsented,
  setConsent,
  initializeGA4,
} from './analytics'

const KEY_COLORS = ['#1287b1', '#3d7fd0', '#e0a04a', '#4ec97a', '#e0574a', '#9b7fe0']

const PRESETS = [
  { key: 'user:42', value: 'ada' },
  { key: 'cart:7', value: '3 items' },
  { key: 'video:9', value: '42 views' },
  { key: 'user:1', value: 'bob' },
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
    hasKeys,
    hasMemtable,
    hasCompactable,
    upNodes,
    downNodes,
    start,
    step,
    play,
    pause,
    resetTo,
  } = useOpLifecycle(initialCluster)

  const [key, setKey] = useState(PRESETS[0].key)
  const [value, setValue] = useState(PRESETS[0].value)
  const [w, setW] = useState(CL.QUORUM)
  const [r, setR] = useState(CL.QUORUM)
  const [inspectNode, setInspectNode] = useState(null) // nodeId being zoomed, or null
  const [sampleLoaded, setSampleLoaded] = useState(false)
  const [showCookieBanner, setShowCookieBanner] = useState(false)

  const clock = useRef(1) // the logical LWW timestamp counter
  const opNum = useRef(1) // read/repair op ids (chip keys)
  const sstNum = useRef(1) // SSTable naming

  // First-run guided tour. It only observes this snapshot to decide which step
  // to show and when the user's real action advanced it.
  const tour = useWalkthrough(
    {
      opType: op?.type ?? null,
      opStep: op ? op.step : -1,
      playing,
      opDone,
      downCount: downNodes.length,
      sampleLoaded,
    },
    { pause },
  )

  // The magnifier only lives on a get's query step and after. Close any open
  // inspector when the op/step leaves the get so it can't linger as a stale
  // overlay after scrubbing or starting a new op.
  const inGetPhase = op?.type === 'get' && op.step >= 3
  useEffect(() => {
    if (!inGetPhase) setInspectNode(null)
  }, [inGetPhase])

  // Initialize analytics with GDPR compliance (skipped entirely without an id
  // or in development).
  useEffect(() => {
    const initAnalytics = async () => {
      if (!GA_MEASUREMENT_ID || import.meta.env.DEV) return
      const consent = hasConsented()
      if (consent === 'accepted') return initializeGA4(GA_MEASUREMENT_ID)
      if (consent === 'declined') return
      const isGDPR = await detectGDPRRegion()
      if (isGDPR) setShowCookieBanner(true)
      else initializeGA4(GA_MEASUREMENT_ID)
    }
    initAnalytics()
  }, [])

  function handleAcceptCookies() {
    setConsent(true)
    setShowCookieBanner(false)
    if (GA_MEASUREMENT_ID && !import.meta.env.DEV) initializeGA4(GA_MEASUREMENT_ID)
  }
  function handleDeclineCookies() {
    setConsent(false)
    setShowCookieBanner(false)
  }

  const keyTrim = key.trim()
  const valueTrim = value.trim()
  const idle = canStartNew && !playing
  const canPut = idle && keyTrim && valueTrim
  const canGet = idle && keyTrim
  const canDel = idle && !!base?.keys[keyTrim]
  const canFlush = idle && hasMemtable
  const canCompact = idle && hasCompactable
  const canRepair = idle && hasKeys

  const keyColor = (k) =>
    base?.keys[k]?.color ?? KEY_COLORS[Object.keys(base?.keys ?? {}).length % KEY_COLORS.length]

  // ---- payload builders: everything impure (timestamps, liveness, replica
  // sets, divergence) is computed HERE against the folded cluster, so the op
  // modules' derive/extra stay pure and scrubbing is deterministic. ----------

  function writePayload(k, v, tombstone) {
    const { token, replicas, walk } = replicaWalk(base, k)
    const down = replicas.filter((nid) => !base.nodes[nid].up)
    const acks = replicas.length - down.length
    return {
      key: k,
      value: v,
      ts: clock.current++,
      tombstone,
      color: keyColor(k),
      w,
      token,
      replicas,
      walk,
      down,
      acks,
      ok: acks >= w,
    }
  }

  function startPut() {
    if (!canPut) return
    start('put', writePayload(keyTrim, valueTrim, false))
  }

  function startDel() {
    if (!canDel) return
    start('del', writePayload(keyTrim, null, true))
  }

  function startGet() {
    if (!canGet) return
    const { token, replicas, walk } = replicaWalk(base, keyTrim)
    const live = replicas.filter((nid) => base.nodes[nid].up)
    const ok = live.length >= r
    const contacted = live.slice(0, Math.min(r, live.length))
    const responses = contacted.map((nid) => ({
      node: nid,
      entry: nodeEntryFor(base.nodes[nid], keyTrim),
    }))
    const winner = responses.reduce(
      (best, x) => (x.entry && (!best || x.entry.ts > best.ts) ? x.entry : best),
      null,
    )
    const repairs = winner
      ? responses.filter((x) => !x.entry || x.entry.ts < winner.ts).map((x) => x.node)
      : []
    start('get', {
      key: keyTrim,
      r,
      id: opNum.current++,
      color: keyColor(keyTrim),
      token,
      replicas,
      walk,
      contacted,
      responses,
      winner,
      repairs: ok ? repairs : [],
      ok,
    })
  }

  function startFlush() {
    if (!canFlush) return
    const targets = upNodes
      .filter((n) => Object.keys(n.memtable).length > 0)
      .map((n) => n.id)
    const names = Object.fromEntries(targets.map((nid) => [nid, `sst-${sstNum.current++}`]))
    start('flush', { targets, names })
  }

  function startCompact() {
    if (!canCompact) return
    const targets = upNodes.filter((n) => n.sstables.length >= 2).map((n) => n.id)
    const names = Object.fromEntries(targets.map((nid) => [nid, `sst-${sstNum.current++}`]))
    start('compact', { targets, names })
  }

  function startRepair() {
    if (!canRepair) return
    const comparisons = Object.keys(base.keys).map((k) => {
      const { token, replicas } = replicaWalk(base, k)
      const upReplicas = replicas.filter((nid) => base.nodes[nid].up)
      const entries = Object.fromEntries(
        upReplicas.map((nid) => [nid, nodeEntryFor(base.nodes[nid], k)]),
      )
      const vals = Object.values(entries)
      const newest = vals.reduce((a, b) => (b && (!a || b.ts > a.ts) ? b : a), null)
      const match = vals.every(
        (e) => (e === null && newest === null) || (e && newest && e.ts === newest.ts),
      )
      return { key: k, token, replicas: upReplicas, entries, match, newest }
    })
    const diffs = comparisons
      .filter((c) => !c.match && c.newest)
      .map((c) => ({
        key: c.key,
        winner: c.newest,
        from: c.replicas.find((nid) => c.entries[nid] && c.entries[nid].ts === c.newest.ts),
        targets: c.replicas.filter(
          (nid) => !c.entries[nid] || c.entries[nid].ts < c.newest.ts,
        ),
        color: keyColor(c.key),
      }))
    start('repair', { id: opNum.current++, comparisons, diffs })
  }

  // Scenario targets are picked at click time: crash prefers a replica of the
  // current key (so the very next put shows a hint), never the coordinator
  // (it's our fixed demo entry point).
  function startCrash() {
    const { replicas } = replicaWalk(base, keyTrim || PRESETS[0].key)
    const candidates = upNodes.map((n) => n.id).filter((nid) => nid !== COORDINATOR)
    const target =
      [...replicas].reverse().find((nid) => candidates.includes(nid)) ?? candidates[0]
    if (!target) return
    start('nodeCrash', { node: target })
  }

  function startRecover() {
    const target = downNodes[0]?.id
    if (!target) return
    const replays = Object.values(base.nodes).flatMap((n) =>
      n.hints
        .filter((h) => h.forNode === target)
        .map((h) => ({ ...h, fromNode: n.id, color: base.keys[h.key]?.color })),
    )
    start('recoverNode', { node: target, replays })
  }

  // Seed a lived-in cluster directly: flushed SSTables, newer memtable
  // versions, and one deliberately stale replica: cart:7 on node-1 missed the
  // t5 write. node-1 is FIRST in cart:7's walk order and reads contact the
  // first R live replicas, so a ONE read returns the stale value, a QUORUM
  // read triggers read repair, and anti-entropy repair sees the divergence —
  // and it shows the coordinator being a replica of the key it coordinates.
  function loadSampleData() {
    if (tour.step?.id !== 'welcome') tour.abort()
    const c = initialCluster()
    let ts = 1
    const seed = (k, v, i, { where, skip } = {}) => {
      const t = ts++
      const color = KEY_COLORS[i % KEY_COLORS.length]
      c.keys[k] = c.keys[k] || { color }
      for (const nid of replicaWalk(c, k).replicas) {
        if (skip === nid) continue
        const entry = { value: v, ts: t, tombstone: false }
        const n = c.nodes[nid]
        if (where === 'sst') {
          let sst = n.sstables[n.sstables.length - 1]
          if (!sst) {
            sst = { id: `sst-${sstNum.current++}`, entries: {} }
            n.sstables.push(sst)
          }
          sst.entries[k] = entry
        } else {
          n.memtable[k] = entry
          n.commitLog += 1
        }
      }
    }
    seed('user:42', 'ada', 0, { where: 'sst' }) // t1, flushed everywhere
    seed('cart:7', '2 items', 1, { where: 'sst' }) // t2, flushed everywhere
    seed('video:9', '41 views', 2, { where: 'sst' }) // t3, flushed everywhere
    seed('user:1', 'bob', 3, {}) // t4, in memtables
    seed('cart:7', '3 items', 1, { skip: 'node-1' }) // t5 — node-1 is STALE
    seed('video:9', '42 views', 2, {}) // t6, newer version shadows t3
    clock.current = ts
    resetTo(c)
    setSampleLoaded(true)
    setInspectNode(null)
  }

  function reset() {
    tour.abort()
    resetTo(initialCluster())
    setSampleLoaded(false)
    clock.current = 1
    opNum.current = 1
    sstNum.current = 1
  }

  const scenarios = [
    {
      key: 'crash',
      icon: '💥',
      label: 'crash a node',
      tooltip: 'A replica of the current key goes silent',
      enabled: idle && upNodes.some((n) => n.id !== COORDINATOR),
      run: startCrash,
    },
    {
      key: 'recover',
      icon: '🔌',
      label: 'recover node',
      tooltip: 'The down node comes back and hints replay',
      enabled: idle && downNodes.length > 0,
      run: startRecover,
    },
  ]

  const currentSteps = op ? stepsFor(op) : []
  const currentStep = op ? currentSteps[op.step] : null
  const strong = w + r > N_REPLICAS
  const keyList = Object.keys(derived.keys)

  return (
    <div className="app">
      <div className="topbar">
        <h1>Cassandra Cluster Visualizer</h1>
        <span className="sub">
          The ring, tunable quorums, hinted handoff, and the LSM tree — a
          leaderless Dynamo-style store, one step at a time
        </span>
      </div>

      <div className="layout">
        {/* ---------------- Left: controls ---------------- */}
        <div className="col">
          <p className="section-title">Request</p>
          <div data-tour="put-area">
            <div className="kv-row">
              <input
                type="text"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="key"
                className="kv-key"
              />
              <input
                type="text"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="value"
                className="kv-value"
              />
            </div>
            <div className="presets">
              {PRESETS.map((p) => (
                <button
                  key={p.key}
                  className="preset-chip"
                  onClick={() => {
                    setKey(p.key)
                    setValue(p.value)
                  }}
                >
                  {p.key}
                </button>
              ))}
            </div>
            <div className="btn-grid" style={{ marginTop: 10 }}>
              <button className="btn primary" onClick={startPut} disabled={!canPut}>
                Put
              </button>
              <button
                className="btn primary"
                data-tour="get-btn"
                onClick={startGet}
                disabled={!canGet}
              >
                Get
              </button>
              <button className="btn" onClick={startDel} disabled={!canDel}>
                Delete
              </button>
            </div>
          </div>

          <p className="section-title" style={{ marginTop: 18 }}>
            Consistency (N = {N_REPLICAS})
          </p>
          <ConsistencyPicker label="W" value={w} onChange={setW} disabled={!idle} />
          <ConsistencyPicker label="R" value={r} onChange={setR} disabled={!idle} />
          <div className={'cl-badge' + (strong ? ' strong' : ' weak')}>
            W+R = {w + r} {strong ? '>' : '≤'} N = {N_REPLICAS} →{' '}
            {strong ? 'reads see the latest write' : 'stale reads possible'}
          </div>

          <p className="section-title" style={{ marginTop: 18 }}>
            Storage &amp; repair
          </p>
          <div className="btn-grid">
            <button className="btn" onClick={startFlush} disabled={!canFlush}>
              Flush
            </button>
            <button className="btn" onClick={startCompact} disabled={!canCompact}>
              Compact
            </button>
            <button className="btn" onClick={startRepair} disabled={!canRepair}>
              Repair
            </button>
            <button className="btn" onClick={reset}>
              Reset
            </button>
          </div>

          <button className="btn block" data-tour="load-sample" style={{ marginTop: 10 }} onClick={loadSampleData}>
            Load sample data
          </button>

          <p className="hint">
            <b>Put</b> a key and watch it hash onto the ring and fan out to all
            3 replicas. <b>Get</b> it back at your chosen R. Then crash a node,
            put again (hint!), recover it, and <b>Repair</b>.
          </p>

          {keyList.length > 0 && (
            <div className="doc-list">
              <p className="section-title">Keys</p>
              {keyList.map((k) => {
                const { token, replicas } = replicaWalk(derived, k)
                return (
                  <div key={k} className="doc-row" onClick={() => setKey(k)}>
                    <span className="dot" style={{ background: derived.keys[k].color }} />
                    <span className="doc-id">{k}</span>
                    <span className="doc-shard">
                      t{token} →{' '}
                      {replicas.map((nid) => (
                        <span
                          key={nid}
                          className="node-dot"
                          style={{ background: NODE_COLORS[nid] }}
                          title={nid}
                        />
                      ))}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* ---------------- Center: ring + nodes ---------------- */}
        <div className="col">
          <div className="stage-head">
            <p className="section-title">Cluster</p>
            <span className="client-pill" data-fly="client">
              🧑‍💻 client
            </span>
            <ScenarioBar scenarios={scenarios} disabled={!idle} />
          </div>
          <ClusterStage
            cluster={derived}
            extra={extra}
            op={op}
            onInspect={(nid) => {
              pause()
              setInspectNode(nid)
            }}
          />
        </div>

        {/* ---------------- Right: explain + context panel ---------------- */}
        <div className="col">
          <p className="section-title">What's happening</p>
          {currentStep ? (
            <div className="explain">
              <h3>{currentStep.title}</h3>
              <p>{currentStep.blurb}</p>
            </div>
          ) : (
            <div className="explain idle">
              <h3>Ready</h3>
              <p>
                Put a key/value to begin — or load the sample data and try a
                Get, a crash, or a Repair. There is no leader here: node-1 just
                happens to be the node this client connects to.
              </p>
            </div>
          )}

          {extra.quorum && <QuorumPanel quorum={extra.quorum} />}
          {extra.merkle && <MerkleView merkle={extra.merkle} keys={derived.keys} />}
        </div>
      </div>

      {/* ---------------- Bottom: stepper ---------------- */}
      <Stepper
        dataTour="stepper"
        steps={currentSteps}
        step={op ? op.step : -1}
        opLabel={op ? OP_LABELS[op.type] : ''}
        playing={playing}
        onPrev={() => step(-1)}
        onNext={() => step(1)}
        onPlay={play}
        onPause={pause}
        highlightPlay={tour.status === 'running' && tour.step?.id === 'stepper'}
      />

      {/* ---------------- Overlay: chip flights ---------------- */}
      {(extra.flights || []).map((f) => (
        <ChipFlight key={f.key} tokens={f.tokens} fromSel={f.fromSel} toSel={f.toSel} />
      ))}

      {/* ---------------- Overlay: node read-path inspector ---------------- */}
      <NodeInspector
        node={inspectNode ? derived.nodes[inspectNode] : null}
        opKey={op?.type === 'get' ? op.payload.key : ''}
        onClose={() => setInspectNode(null)}
      />

      {/* ---------------- Cookie consent (GDPR regions only) ---------------- */}
      {showCookieBanner && (
        <CookieBanner onAccept={handleAcceptCookies} onDecline={handleDeclineCookies} />
      )}

      {/* ---------------- Overlay: first-run guided tour ---------------- */}
      <Walkthrough tour={tour} allowEscape={inspectNode == null} />
    </div>
  )
}
