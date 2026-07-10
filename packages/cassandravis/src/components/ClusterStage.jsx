import { motion, AnimatePresence } from 'framer-motion'
import { COORDINATOR, NODE_COLORS } from '../cluster'
import Ring from './Ring'

// The centre stage: a client pill, the token ring, and the node cards.
// Highlights and badges are driven by the current operation + step (opExtra).
export default function ClusterStage({ cluster, extra, op, onInspect }) {
  const focus = new Set(extra.focus || [])
  const nodes = Object.values(cluster.nodes)

  // During a get's query step (and after), contacted replicas can be zoomed
  // into to see their local read path.
  const inspectable =
    op?.type === 'get' && op.step >= 3 ? new Set(op.payload.contacted) : new Set()

  return (
    <div className="cluster">
      <div className="client-row">
        <span className="client-pill" data-fly="client">
          🧑‍💻 client
        </span>
      </div>

      <Ring cluster={cluster} walkState={extra.ring} />

      <div className="nodes-grid">
        {nodes.map((node) => (
          <NodeCard
            key={node.id}
            node={node}
            keys={cluster.keys}
            active={focus.has(node.id)}
            inspectable={inspectable.has(node.id)}
            compactSelecting={extra.compact?.selecting && extra.compact.targets.includes(node.id)}
            onInspect={onInspect}
          />
        ))}
      </div>
    </div>
  )
}

function NodeCard({ node, keys, active, inspectable, compactSelecting, onInspect }) {
  const memEntries = Object.entries(node.memtable)
  return (
    <div
      data-fly={node.id}
      className={
        'node-card' + (active ? ' active' : '') + (node.up ? '' : ' down')
      }
      style={{ '--node-accent': NODE_COLORS[node.id] }}
    >
      {!node.up && <div className="down-banner">✕ DOWN — unreachable</div>}
      <div className="node-head">
        <span className="node-dot" style={{ background: NODE_COLORS[node.id] }} />
        <span className="node-name">{node.id}</span>
        <span className="node-tokens">t{node.tokens.join(' · t')}</span>
        {node.id === COORDINATOR && <span className="badge-coord">coordinator</span>}
        {inspectable && node.up && (
          <button
            className="magnify-btn"
            data-tour="magnify"
            title="Zoom into this node's local read path"
            onClick={() => onInspect?.(node.id)}
          >
            🔍
          </button>
        )}
      </div>

      <div className="memtable-box">
        <div className="store-label">memtable · in memory</div>
        <div className="chip-row">
          {memEntries.length === 0 && <span className="empty-note small">empty</span>}
          <AnimatePresence>
            {memEntries.map(([k, e]) => (
              <EntryChip key={k} k={k} entry={e} keys={keys} />
            ))}
          </AnimatePresence>
        </div>
      </div>

      <div className="commitlog-line">commit log: {node.commitLog}</div>

      <div className="seg-stack">
        <AnimatePresence mode="popLayout">
          {node.sstables.length === 0 && (
            <span className="empty-note small" key="none">
              no SSTables
            </span>
          )}
          {[...node.sstables].reverse().map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.85 }}
              transition={{ type: 'spring', stiffness: 280, damping: 24 }}
              className={'mini-seg' + (compactSelecting ? ' merging' : '')}
            >
              <div className="mini-seg-head">
                <span className="lock">🔒</span>
                {t.id}
                <span className="bloom-chip" title="bloom filter over this SSTable's keys">
                  ◌ bloom
                </span>
              </div>
              <div className="chip-row">
                {Object.entries(t.entries).map(([k, e]) => (
                  <EntryChip key={k} k={k} entry={e} keys={keys} small />
                ))}
                {Object.keys(t.entries).length === 0 && (
                  <span className="empty-note small">empty</span>
                )}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {node.hints.length > 0 && (
        <div className="hints-tray">
          <div className="store-label">📩 hints held for down replicas</div>
          <div className="chip-row">
            {node.hints.map((h, i) => (
              <span
                key={`${h.forNode}-${h.key}-${h.ts}`}
                className="hint-chip"
                style={{ borderColor: NODE_COLORS[h.forNode] }}
              >
                {h.tombstone ? '🪦' : ''}
                {h.key} → {h.forNode}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function EntryChip({ k, entry, keys, small }) {
  return (
    <motion.span
      layout
      initial={{ opacity: 0, scale: 0.7 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.7 }}
      className={'entry-chip' + (entry.tombstone ? ' tombstone' : '') + (small ? ' small' : '')}
      style={{ background: keys[k]?.color || '#888' }}
      title={entry.tombstone ? `tombstone · t${entry.ts}` : `${k} = ${entry.value} · t${entry.ts}`}
    >
      {entry.tombstone ? `🪦 ${k}` : `${k}=${entry.value}`}
      <span className="ts">t{entry.ts}</span>
    </motion.span>
  )
}
