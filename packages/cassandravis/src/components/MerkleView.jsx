import { NODE_COLORS } from '../cluster'

// Right-panel view during a repair: the Merkle comparison the blurbs narrate,
// top-down — a per-node ROOT row first (hash of that node's leaf hashes), then
// the per-key "leaf" rows across each key's up replicas. Real trees hash
// ranges, not single keys, and are much deeper — this is the 2-level
// simplification the SPEC flags. Driven by opExtra's `merkle`.

// A stable, fake-but-deterministic short hash, so equal data shows equal
// hashes and divergent data visibly differs.
function fnv(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 16777619) >>> 0
  return h.toString(16).slice(0, 4)
}

const leafHash = (entry) =>
  entry ? fnv(`${entry.value}|${entry.ts}|${entry.tombstone ? 1 : 0}`) : '––––'

export default function MerkleView({ merkle, keys, onCloseUp }) {
  if (!merkle) return null
  const { comparisons, compared, streamed } = merkle

  // Resolve each comparison's per-replica entries once (after streaming,
  // everything converges on the newest entry) and fold them into per-node
  // leaf lists for the root row.
  const resolved = comparisons.map((c) => {
    const newest = Object.values(c.entries).reduce(
      (a, b) => (b && (!a || b.ts > a.ts) ? b : a),
      null,
    )
    const entries = c.replicas.map((nid) => ({
      nid,
      entry: streamed && !c.match ? newest : c.entries[nid],
    }))
    return { ...c, entries, allMatch: streamed || c.match }
  })

  const perNode = {} // nid -> { leaves: ['key:hash'], diverged }
  for (const c of resolved) {
    for (const { nid, entry } of c.entries) {
      const info = (perNode[nid] ??= { leaves: [], diverged: false })
      info.leaves.push(`${c.key}:${leafHash(entry)}`)
      if (!c.allMatch) info.diverged = true
    }
  }
  const rootNodes = Object.keys(perNode).sort()
  const anyDiverged = rootNodes.some((nid) => perNode[nid].diverged)

  return (
    <div className="merkle-panel">
      <p className="section-title merkle-title">
        Repair · Merkle trees (roots → leaves)
        {onCloseUp && (
          <button
            className="magnify-btn cu-btn"
            title="Zoom into the Merkle trees, root to leaf"
            onClick={onCloseUp}
          >
            🔍
          </button>
        )}
      </p>
      {comparisons.length === 0 && <div className="empty-note">no keys stored yet</div>}

      {comparisons.length > 0 && (
        <div className="merkle-row merkle-roots">
          <span className="merkle-root-label">roots</span>
          <div className="merkle-hashes">
            {rootNodes.map((nid) => (
              <span
                key={nid}
                className={
                  'merkle-hash' +
                  (!compared ? '' : perNode[nid].diverged ? ' mismatch' : ' match')
                }
                title={`${nid}'s root — the hash of its leaf hashes below. Roots that disagree send the comparison descending into the leaves.`}
              >
                <span className="node-dot" style={{ background: NODE_COLORS[nid] }} />
                {fnv(perNode[nid].leaves.join('|'))}
              </span>
            ))}
          </div>
          {compared && (
            <span className={'merkle-flag' + (anyDiverged ? ' diff' : ' ok')}>
              {anyDiverged ? '≠' : '✓'}
            </span>
          )}
        </div>
      )}

      {resolved.map((c) => (
        <div className="merkle-row" key={c.key}>
          <span className="entry-chip small" style={{ background: keys[c.key]?.color || '#888' }}>
            {c.key}
          </span>
          <div className="merkle-hashes">
            {c.entries.map(({ nid, entry }) => (
              <span
                key={nid}
                className={
                  'merkle-hash' + (!compared ? '' : c.allMatch ? ' match' : ' mismatch')
                }
                title={`${nid}: ${entry ? (entry.tombstone ? `tombstone t${entry.ts}` : `${entry.value} t${entry.ts}`) : 'missing'}`}
              >
                <span className="node-dot" style={{ background: NODE_COLORS[nid] }} />
                {leafHash(entry)}
              </span>
            ))}
          </div>
          {compared && (
            <span className={'merkle-flag' + (c.allMatch ? ' ok' : ' diff')}>
              {c.allMatch ? '✓' : '≠'}
            </span>
          )}
        </div>
      ))}
      <p className="q-note">
        Hashes are compared, not data — matching roots end the comparison; only
        mismatching leaves stream entries.
      </p>
    </div>
  )
}
