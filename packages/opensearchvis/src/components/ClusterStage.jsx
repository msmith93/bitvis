import { motion, AnimatePresence } from 'framer-motion'
import { NODES, SHARD_PLACEMENT, COORDINATOR, shardsOnNode } from '../cluster'

const copyKey = (shard, role) => `${shard}:${role}`

// The centre stage: a coordinator/request bar on top, then the 3-node cluster.
// Highlights and badges are driven by the current operation + step.
export default function ClusterStage({ cluster, extra, op, onZoom }) {
  const type = op?.type
  const step = op?.step ?? -1
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
    if (step >= 1 && step <= 2) {
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

  // Matched docs per shard (search), highlighted on the serving copy only.
  const matched = new Set()
  if (type === 'search' && search && step >= 2) {
    for (const [sid, hits] of Object.entries(search.perShard))
      for (const h of hits) matched.add(`${sid}:${h.docId}`)
  }
  const servingRole = (sid) => search?.serving?.[sid]?.role

  // Suppress the in-flight doc on the replica copy until it has been replicated.
  const suppressId =
    inflight && inflight.onPrimary && !inflight.onReplica ? inflight.doc.id : null

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
                  scanning={isServing && step === 2}
                  onZoom={onZoom}
                  mergeSelecting={
                    type === 'merge' && step === 0 && extra.merge?.shards.includes(shard)
                  }
                />
              )
            })}
          </div>
        ))}
      </div>
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
  onZoom,
  mergeSelecting,
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
      </div>

      {buffer.length > 0 && (
        <div className="buffer-box">
          <div className="buffer-label">buffer · not searchable</div>
          <div className="chip-row">
            {buffer.map((id) => (
              <DocChip key={id} id={id} docs={docs} />
            ))}
          </div>
        </div>
      )}

      <div className="translog-line">translog: {shard.translog.length}</div>

      <div className="seg-stack">
        <AnimatePresence mode="popLayout">
          {shard.segments.length === 0 && (
            <span className="empty-note small">no segments</span>
          )}
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

function DocChip({ id, docs, hit }) {
  const d = docs[id]
  return (
    <span
      className={'doc-chip' + (d?.deleted ? ' deleted' : '') + (hit ? ' hit' : '')}
      style={{ background: d?.color || '#888' }}
    >
      {id}
    </span>
  )
}
