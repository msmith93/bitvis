import { readValue, NODE_COLORS } from '../cluster'

// The zoom-in overlay during a get: ONE node's local read path, traced exactly
// as readValue() in cluster.js computes it — memtable first, then SSTables
// newest-first, consulting each SSTable's bloom filter. `node` is the node
// from the DERIVED cluster so the trace matches what's on screen.
export default function NodeInspector({ node, opKey, onClose }) {
  if (!node) return null
  const { entry, source, trace } = readValue(node, opKey)

  return (
    <div className="inspector-backdrop" onClick={onClose}>
      <div className="inspector-card" onClick={(e) => e.stopPropagation()}>
        <div className="inspector-head">
          <span className="node-dot" style={{ background: NODE_COLORS[node.id] }} />
          <h3>
            {node.id} · local read path for <code>{opKey}</code>
          </h3>
          <button className="btn mini" onClick={onClose}>
            ✕ close
          </button>
        </div>

        <p className="inspector-intro">
          A replica answers a read from its own LSM tree: the memtable first, then each
          immutable SSTable <b>newest-first</b>. A bloom filter in front of every SSTable says
          "definitely not here" or "maybe here", letting the read skip tables entirely. The
          newest timestamp among everything found wins.
        </p>

        <div className="trace-rows">
          {trace.map((t, i) => (
            <div
              className={'trace-row' + (t.hit ? ' hit' : '') + (source === t.where && t.hit ? ' winner' : '')}
              key={i}
            >
              <span className="trace-where">
                {t.where === 'memtable' ? '① memtable' : `${['②', '③', '④', '⑤', '⑥'][i - 1] || '·'} ${t.where} 🔒`}
              </span>
              {t.where !== 'memtable' && (
                <span className={'trace-bloom' + (t.bloom ? ' maybe' : ' no')}>
                  bloom: {t.bloom ? 'maybe → read it' : 'no → skip (never wrong about no)'}
                </span>
              )}
              <span className="trace-result">
                {t.bloom === false
                  ? '—'
                  : t.hit
                  ? t.entry.tombstone
                    ? `🪦 tombstone · t${t.entry.ts}`
                    : `${opKey} = ${t.entry.value} · t${t.entry.ts}`
                  : 'not present'}
              </span>
            </div>
          ))}
        </div>

        <div className={'trace-verdict' + (entry && !entry.tombstone ? ' ok' : '')}>
          {entry
            ? entry.tombstone
              ? `Newest version is a tombstone (t${entry.ts}, from ${source}) → this replica answers "not found".`
              : `Newest version: ${entry.value} (t${entry.ts}, from ${source}) → returned to the coordinator with its timestamp.`
            : `Nothing found anywhere → this replica answers "no data".`}
        </div>
      </div>
    </div>
  )
}
