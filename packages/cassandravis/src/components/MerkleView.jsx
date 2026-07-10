import { NODE_COLORS } from '../cluster'

// Right-panel view during a repair: per-key Merkle "leaf" comparison across
// the key's up replicas. Real trees hash ranges, not single keys — this is the
// 2-level simplification the SPEC flags. Driven by opExtra's `merkle`.

// A stable, fake-but-deterministic short hash for an entry, so equal data
// shows equal hashes and divergent data visibly differs.
function leafHash(entry) {
  if (!entry) return '––––'
  const s = `${entry.value}|${entry.ts}|${entry.tombstone ? 1 : 0}`
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 16777619) >>> 0
  return h.toString(16).slice(0, 4)
}

export default function MerkleView({ merkle, keys }) {
  if (!merkle) return null
  const { comparisons, compared, streamed } = merkle
  return (
    <div className="merkle-panel">
      <p className="section-title">Repair · Merkle leaves</p>
      {comparisons.length === 0 && <div className="empty-note">no keys stored yet</div>}
      {comparisons.map((c) => {
        // After streaming, everything converges on the newest entry.
        const entries = c.replicas.map((nid) => {
          if (streamed && !c.match) {
            const newest = Object.values(c.entries).reduce(
              (a, b) => (b && (!a || b.ts > a.ts) ? b : a),
              null,
            )
            return { nid, entry: newest }
          }
          return { nid, entry: c.entries[nid] }
        })
        const allMatch = streamed || c.match
        return (
          <div className="merkle-row" key={c.key}>
            <span className="entry-chip small" style={{ background: keys[c.key]?.color || '#888' }}>
              {c.key}
            </span>
            <div className="merkle-hashes">
              {entries.map(({ nid, entry }) => (
                <span
                  key={nid}
                  className={
                    'merkle-hash' +
                    (!compared ? '' : allMatch ? ' match' : ' mismatch')
                  }
                  title={`${nid}: ${entry ? (entry.tombstone ? `tombstone t${entry.ts}` : `${entry.value} t${entry.ts}`) : 'missing'}`}
                >
                  <span className="node-dot" style={{ background: NODE_COLORS[nid] }} />
                  {leafHash(entry)}
                </span>
              ))}
            </div>
            {compared && (
              <span className={'merkle-flag' + (allMatch ? ' ok' : ' diff')}>
                {allMatch ? '✓' : '≠'}
              </span>
            )}
          </div>
        )
      })}
      <p className="q-note">
        Hashes are compared, not data — only mismatching leaves stream entries.
      </p>
    </div>
  )
}
