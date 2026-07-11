import { motion } from 'framer-motion'
import { NODE_COLORS } from '../cluster'
import { Mut } from './shared'

// Close-up: one node's compaction — the per-key merge that the stage shows
// only as "tables became one". `baseNode` is the node BEFORE the merge, so the
// input tables and every shadowed version are still visible.
export function build(nodeId, baseNode, sstName, keysMeta) {
  const tables = baseNode.sstables
  // Per key: every version across the input tables, oldest table first.
  const byKey = {}
  tables.forEach((t, ti) => {
    for (const [k, e] of Object.entries(t.entries)) (byKey[k] ??= []).push({ sst: t.id, ti, e })
  })
  const keys = Object.keys(byKey).sort()
  const rows = keys.map((k) => {
    const versions = byKey[k]
    const winner = versions.reduce((a, b) => (b.e.ts > a.e.ts ? b : a))
    return { k, versions, winner, reclaimed: winner.e.tombstone }
  })
  const reclaimedCount = rows.filter((r) => r.reclaimed).length
  const survivors = rows.filter((r) => !r.reclaimed)

  const steps = [
    {
      key: 'select',
      title: `1 · ${tables.length} SSTables go in`,
      blurb: `Reads pay for every extra table (${tables.length} bloom checks, up to ${tables.length} lookups), and old shadowed versions can never be trimmed in place — SSTables are immutable. So compaction rewrites: ${tables.map((t) => t.id).join(' + ')} → one new table.`,
    },
    {
      key: 'merge',
      title: '2 · Merge per key — newest timestamp wins',
      blurb: 'Both inputs are sorted, so a merge walks them like a zipper, key by key. Where a key appears in several tables, only the highest-timestamped version survives; the shadowed ones are simply not copied into the output.',
    },
    {
      key: 'gc',
      title: '3 · Reclaim tombstones',
      blurb: reclaimedCount
        ? `A key whose WINNING version is a tombstone is dropped entirely — marker and shadowed values both. This is the moment a delete finally frees space. (Real Cassandra waits gc_grace_seconds first, so a down replica can still learn of the delete — drop the marker too early and repair can resurrect the value.)`
        : 'No key\'s winning version is a tombstone here, so nothing is reclaimed — but this is the step where deletes WOULD finally free space. (Real Cassandra holds tombstones for gc_grace_seconds first to avoid resurrecting data via a replica that never heard about the delete.)',
    },
    {
      key: 'result',
      title: `4 · ${sstName} replaces them all`,
      blurb: `The node now has one table with exactly one version per live key. Reads get faster, space is reclaimed, and the inputs are deleted. Like flush, this was entirely LOCAL — the other replicas compact on their own schedules.`,
    },
  ]

  function Stage({ step }) {
    return (
      <div className="cu-rows">
        <div className="cu-banner">
          <span className="node-dot" style={{ background: NODE_COLORS[nodeId] }} />
          <span className="cu-cell">
            {nodeId} · {tables.map((t) => `🔒 ${t.id}`).join('  +  ')} → {sstName}
          </span>
        </div>

        {rows.map((r, i) => {
          const dropped = step >= 2 && r.reclaimed
          return (
            <motion.div
              key={r.k}
              className={'cu-row' + (dropped ? ' bad' : '')}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: dropped ? 0.55 : 1, y: 0 }}
              transition={{ delay: step === 1 ? i * 0.2 : 0 }}
            >
              <span className="cu-cell mono">{r.k}</span>
              <span className="cu-cell chips">
                {r.versions.map((v) => (
                  <span key={v.sst} className="cu-versioned">
                    <Mut
                      k={r.k}
                      value={v.e.value}
                      ts={v.e.ts}
                      tombstone={v.e.tombstone}
                      color={keysMeta[r.k]?.color}
                      struck={step >= 1 && v !== r.winner}
                    />
                    <span className="cu-note">{v.sst}</span>
                  </span>
                ))}
              </span>
              <span className="cu-cell right">
                {step < 1
                  ? ''
                  : dropped
                    ? '🪦 wins → RECLAIMED'
                    : `t${r.winner.e.ts} wins${r.versions.length > 1 ? ` (${r.versions.length - 1} shadowed dropped)` : ''}`}
              </span>
            </motion.div>
          )
        })}

        {step >= 3 && (
          <motion.div className="cu-row ok" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
            <span className="cu-cell">🔒 {sstName}</span>
            <span className="cu-cell chips">
              {survivors.length === 0 ? (
                <span className="cu-note">empty — everything was reclaimed</span>
              ) : (
                survivors.map((r) => (
                  <Mut
                    key={r.k}
                    k={r.k}
                    value={r.winner.e.value}
                    ts={r.winner.e.ts}
                    tombstone={false}
                    color={keysMeta[r.k]?.color}
                  />
                ))
              )}
            </span>
            <span className="cu-cell right dim">
              {tables.length} tables → 1{reclaimedCount ? ` · ${reclaimedCount} key${reclaimedCount === 1 ? '' : 's'} reclaimed` : ''}
            </span>
          </motion.div>
        )}
      </div>
    )
  }

  return {
    key: `compact-${nodeId}`,
    title: `${nodeId} · compaction, key by key`,
    sub: `${nodeId} · compact`,
    source: `[data-fly="${nodeId}"]`,
    steps,
    Stage,
  }
}
