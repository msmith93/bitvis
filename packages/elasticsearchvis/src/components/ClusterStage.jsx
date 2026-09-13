import { useCallback, useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { NODES, SHARD_PLACEMENT, COORDINATOR, shardsOnNode } from '../cluster'
import { PEEK_OPEN_MS, PEEK_CLOSE_MS } from '../timing'
import { fetchShards } from '../closeups'
import { searchStepKey } from '../ops/search'
import DocPeek from './DocPeek'

const copyKey = (shard, role) => `${shard}:${role}`

// The centre stage: a coordinator/request bar on top, then the 3-node cluster.
// Highlights and badges are driven by the current operation + step.
export default function ClusterStage({
  cluster,
  extra,
  op,
  playing,
  onZoom,
  onCoordZoom,
  onFetchZoom,
  onStatsZoom,
}) {
  const type = op?.type
  const step = op?.step ?? -1
  // The search op's PHASE, by key. dfs_query_then_fetch prepends a statistics
  // round trip, so every step index after it moves while the keys do not —
  // every search-phase test below goes through this, never through `step`.
  const phase = searchStepKey(op)
  const inflight = extra.inflight
  const search = extra.search

  const activeNodes = new Set()
  const activeCopies = new Set()

  if (type === 'index' && inflight) {
    const place = SHARD_PLACEMENT[inflight.shard]
    activeNodes.add(COORDINATOR)
    if (inflight.routed) {
      activeNodes.add(place.primaryNode)
      activeCopies.add(copyKey(inflight.shard, 'primary'))
    }
    if (inflight.onReplica) {
      activeNodes.add(place.replicaNode)
      activeCopies.add(copyKey(inflight.shard, 'replica'))
    }
  } else if (type === 'refresh') {
    for (const sid of extra.refresh?.shards || []) markShard(sid)
  } else if (type === 'merge') {
    for (const sid of extra.merge?.shards || []) markShard(sid)
  } else if (type === 'flush') {
    NODES.forEach((n) => activeNodes.add(n.id))
  } else if (type === 'search' && search) {
    activeNodes.add(COORDINATOR)
    if (phase === 'dfs' || phase === 'scatter' || phase === 'local') {
      for (const [sid, sv] of Object.entries(search.serving)) {
        activeNodes.add(sv.node)
        activeCopies.add(copyKey(Number(sid), sv.role))
      }
    }
  }

  function markShard(sid) {
    const p = SHARD_PLACEMENT[sid]
    activeNodes.add(p.primaryNode)
    activeNodes.add(p.replicaNode)
    activeCopies.add(copyKey(sid, 'primary'))
    activeCopies.add(copyKey(sid, 'replica'))
  }

  // From the local-search phase on, a shard's matches stay highlighted.
  const SEARCH_MATCHED_PHASES = new Set(['local', 'gather', 'fetch', 'return'])
  // Matched docs per shard (search), highlighted on the serving copy only.
  const matched = new Set()
  if (type === 'search' && search && SEARCH_MATCHED_PHASES.has(phase)) {
    for (const [sid, hits] of Object.entries(search.perShard))
      for (const h of hits) matched.add(`${sid}:${h.docId}`)
  }
  const servingRole = (sid) => search?.serving?.[sid]?.role
  // The fetch phase asks only the shards holding a winner of the cut — the same
  // slice SearchFlight flies its GET _source to.
  const fetching = type === 'search' && phase === 'fetch' && search ? fetchShards(search) : {}

  // Suppress the in-flight doc on the replica copy until it has been replicated.
  const suppressId =
    inflight && inflight.onPrimary && !inflight.onReplica ? inflight.doc.id : null

  // ---- doc-pill peek --------------------------------------------------------
  // Which chip the pointer (or keyboard focus) is resting on, and where it was
  // when it opened. One piece of state for the whole stage rather than one per
  // chip: only one can be hovered, and the card is a single fixed layer.
  const [peek, setPeek] = useState(null) // { id, rect }
  const peekTimer = useRef(null)

  const openPeek = useCallback((id, el) => {
    clearTimeout(peekTimer.current)
    peekTimer.current = setTimeout(() => {
      // The chip can be gone by the time the delay elapses — a refresh moves it
      // out of the buffer, a merge renumbers it away — and measuring a detached
      // node yields an all-zero rect that would park the card in the corner.
      if (el.isConnected) setPeek({ id, rect: el.getBoundingClientRect() })
    }, PEEK_OPEN_MS)
  }, [])

  const closePeek = useCallback(() => {
    clearTimeout(peekTimer.current)
    peekTimer.current = setTimeout(() => setPeek(null), PEEK_CLOSE_MS)
  }, [])

  // Auto-play owns the screen: chips are moving between boxes under framer
  // layout springs, so a card anchored to a rect measured a moment ago would be
  // pointing at nothing. Inspection is a paused activity.
  useEffect(() => {
    if (playing) {
      clearTimeout(peekTimer.current)
      setPeek(null)
    }
  }, [playing])

  useEffect(() => () => clearTimeout(peekTimer.current), [])

  const peekProps = playing ? null : { onPeek: openPeek, onPeekEnd: closePeek }

  return (
    <div className="cluster">
      <div className="nodes-row">
        {NODES.map((node) => (
          <div
            key={node.id}
            data-coordinator={node.id === COORDINATOR ? '' : undefined}
            className={'node-col' + (activeNodes.has(node.id) ? ' active' : '')}
          >
            <div className="node-head">
              <span className="node-name">{node.name}</span>
              {node.id === COORDINATOR && (
                <span className="badge-coord">coordinator</span>
              )}
              {node.id === COORDINATOR &&
                type === 'search' &&
                (phase === 'gather' || phase === 'fetch') &&
                search?.totalHits > 0 && (
                  <button
                    className="magnify-btn coord"
                    data-tour="coord-magnify"
                    title="Zoom into the coordinator's merge & fetch"
                    onClick={() => onCoordZoom?.()}
                  >
                    🔍
                  </button>
                )}
            </div>

            {shardsOnNode(node.id).map(({ shard, role }) => {
              const shardData = cluster.shards.find((s) => s.id === shard)
              const isServing = type === 'search' && servingRole(shard) === role
              return (
                <ShardCard
                  key={`${shard}-${role}`}
                  shard={shardData}
                  role={role}
                  docs={cluster.docs}
                  active={activeCopies.has(copyKey(shard, role))}
                  suppressId={role === 'replica' ? suppressId : null}
                  matched={matched}
                  isServing={isServing}
                  scanning={isServing && phase === 'local'}
                  fetching={isServing && !!fetching[shard]}
                  collecting={isServing && phase === 'dfs'}
                  onZoom={onZoom}
                  onFetchZoom={onFetchZoom}
                  onStatsZoom={onStatsZoom}
                  mergeSelecting={
                    type === 'merge' && step === 0 && extra.merge?.shards.includes(shard)
                  }
                  peekProps={peekProps}
                />
              )
            })}
          </div>
        ))}
      </div>

      <DocPeek peek={peek} docs={cluster.docs} />
    </div>
  )
}

function ShardCard({
  shard,
  role,
  docs,
  active,
  suppressId,
  matched,
  isServing,
  scanning,
  fetching,
  collecting,
  onZoom,
  onFetchZoom,
  onStatsZoom,
  mergeSelecting,
  peekProps,
}) {
  const buffer = shard.buffer.filter((id) => id !== suppressId)
  return (
    <div
      data-shard-target={role === 'primary' ? shard.id : undefined}
      data-replica-target={role === 'replica' ? shard.id : undefined}
      className={
        'shard-card' +
        (active ? ' active' : '') +
        (role === 'primary' ? ' primary' : ' replica') +
        (isServing ? ' serving' : '') +
        (scanning ? ' scanning' : '')
      }
    >
      {scanning && <div className="scan-line" />}
      <div className="shard-head">
        <span className="shard-id">shard {shard.id}</span>
        <span className={'role-badge ' + role}>{role}</span>
        {isServing && <span className="serving-badge">serving</span>}
        {scanning && (
          <button
            className="magnify-btn"
            data-tour={
              // The tour spotlights the first [data-tour="magnify"] in the DOM,
              // so only tag copies whose shard has something searchable — the
              // guided click should land on the shard that holds the user's
              // document, not an empty one.
              shard.segments.some((seg) => seg.searchable) ? 'magnify' : undefined
            }
            title="Zoom into this shard's local search"
            onClick={() => onZoom?.(shard.id)}
          >
            🔍
          </button>
        )}
        {fetching && (
          <button
            className="magnify-btn"
            data-tour="fetch-magnify"
            title="Zoom into this shard's fetch: the winners' _source read off disk"
            onClick={() => onFetchZoom?.(shard.id)}
          >
            🔍
          </button>
        )}
        {/* dfs only: what a shard does to answer a statistics request. Worth its
            own glass because the answer is "much less than a search" and there
            is no way to see that from out here. */}
        {collecting && (
          <button
            className="magnify-btn"
            data-tour="stats-magnify"
            title="Zoom into this shard answering the statistics request"
            onClick={() => onStatsZoom?.(shard.id)}
          >
            🔍
          </button>
        )}
      </div>

      {buffer.length > 0 && (
        <div className="buffer-box">
          <div className="buffer-label">buffer · not searchable</div>
          <div className="chip-row">
            {buffer.map((id) => (
              <DocChip key={id} id={id} docs={docs} peekProps={peekProps} />
            ))}
          </div>
        </div>
      )}

      <div className="translog-line">translog: {shard.translog.length}</div>

      <div className="seg-stack">
        <AnimatePresence mode="popLayout">
          {shard.segments.map((seg) => (
            <motion.div
              key={seg.id}
              layout
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.85 }}
              transition={{ type: 'spring', stiffness: 280, damping: 24 }}
              className={
                'mini-seg' +
                (seg.committed ? ' committed' : '') +
                (seg.searchable ? '' : ' pending') +
                (mergeSelecting && seg.searchable ? ' merging' : '')
              }
            >
              <div className="mini-seg-head">
                <span className="lock">🔒</span>
                {seg.id}
                <span className="mini-seg-flag">
                  {!seg.searchable
                    ? 'writing…'
                    : seg.committed
                    ? 'committed'
                    : 'searchable'}
                </span>
              </div>
              <div className="chip-row">
                {seg.docIds.map((id) => (
                  <DocChip
                    key={id}
                    id={id}
                    docs={docs}
                    hit={isServing && matched.has(`${shard.id}:${id}`)}
                    peekProps={peekProps}
                  />
                ))}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  )
}

// One LUCENE doc. A nested child is drawn smaller and dimmer than its root and
// labelled by its ordinal within the block, so a block reads as "these belong to
// that one" — and so a segment that has quietly grown 4x says so at a glance.
//
// Resting on a chip peeks at its `_source` (DocPeek). `peekProps` is null while
// auto-play runs, which is what disables the peek then — a chip with no handlers
// rather than a card that checks a flag. The chip is focusable so the peek is
// reachable from the keyboard and not hover-only; the native `title` it used to
// carry is gone, since two tooltips racing on one element is worse than either.
function DocChip({ id, docs, hit, peekProps }) {
  const d = docs[id]
  const child = d?.kind === 'child'
  return (
    <span
      className={
        'doc-chip' +
        (child ? ' child' : '') +
        (d?.deleted ? ' deleted' : '') +
        // The refresh that applies a tombstone is otherwise INVISIBLE here —
        // this is the only thing on the main stage that moves when a delete
        // leaves the searchable view. The shard close-up has always drawn it.
        (d?.purged ? ' purged' : '') +
        (hit ? ' hit' : '') +
        (peekProps ? ' peekable' : '')
      }
      style={{ background: d?.color || '#888' }}
      tabIndex={peekProps ? 0 : undefined}
      aria-label={peekProps ? `${child ? `${d.root} · ${d.detail}` : id} — show _source` : undefined}
      onMouseEnter={peekProps && ((e) => peekProps.onPeek(id, e.currentTarget))}
      onMouseLeave={peekProps?.onPeekEnd}
      onFocus={peekProps && ((e) => peekProps.onPeek(id, e.currentTarget))}
      onBlur={peekProps?.onPeekEnd}
    >
      {child ? `#${id.slice(id.lastIndexOf('#') + 1)}` : id}
    </span>
  )
}
