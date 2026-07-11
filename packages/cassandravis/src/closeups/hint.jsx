import { motion } from 'framer-motion'
import { NODE_COLORS } from '../cluster'
import { Mut } from './shared'

// Close-up: hinted handoff completing on the recovered node. `baseNode` is the
// node as it stood BEFORE recovery, so the LWW guard's comparisons are visible.
// replays: [{ fromNode, key, value, ts, tombstone, color }]
export function build(nodeId, baseNode, replays) {
  const verdicts = replays.map((h) => {
    const cur = baseNode.memtable[h.key] || null
    return { h, cur, applies: !cur || h.ts > cur.ts }
  })
  const applied = verdicts.filter((v) => v.applies).length

  const steps = [
    {
      key: 'deliver',
      title: `1 · ${replays.length} stored hint${replays.length === 1 ? '' : 's'} stream over`,
      blurb: `The node is UP again, and the holders of its hints noticed via gossip. Each hint is the complete original mutation — key, value, and its ORIGINAL timestamp — parked when this node couldn't be reached. (Real hints expire, e.g. after 3h; outlast the window and only repair can catch you up.)`,
    },
    {
      key: 'guard',
      title: '2 · The LWW guard: a hint never regresses',
      blurb: 'Before applying, each hint\'s timestamp is compared against what the node already has for that key. A hint that lost the race while parked (something newer arrived by another path) is discarded — applying it blindly would resurrect old data.',
    },
    {
      key: 'apply',
      title: '3 · Applied through the NORMAL write path',
      blurb: 'A winning hint is just a late write: commit log append, memtable upsert — identical to a mutation arriving from a coordinator. No special "recovery mode" storage; the write path is the only door into a replica.',
    },
    {
      key: 'discharge',
      title: '4 · The holders discharge their hints',
      blurb: `Delivered hints are deleted on the nodes that held them — the debt is paid. ${nodeId} now has everything it was hinted${applied < replays.length ? ` (${replays.length - applied} hint${replays.length - applied === 1 ? ' was' : 's were'} stale and rightly skipped)` : ''}; anything hints never covered is repair's job.`,
    },
  ]

  function Stage({ step }) {
    return (
      <div className="cu-rows">
        <div className="cu-banner">
          <span className="node-dot" style={{ background: NODE_COLORS[nodeId] }} />
          <span className="cu-cell">{nodeId} · back UP — hints incoming</span>
        </div>

        {verdicts.map(({ h, cur, applies }, i) => (
          <motion.div
            key={`${h.key}-${h.ts}`}
            className={'cu-row' + (step >= 1 ? (applies ? ' ok' : ' bad') : '')}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: step === 0 ? i * 0.2 : 0 }}
          >
            <span className="cu-cell dim">from {h.fromNode}:</span>
            <Mut k={h.key} value={h.value} ts={h.ts} tombstone={h.tombstone} color={h.color} />
            <span className="cu-cell mono dim">
              {step >= 1 && (cur ? `local: t${cur.ts}` : 'local: nothing')}
            </span>
            <span className="cu-cell right">
              {step < 1
                ? '📩'
                : applies
                  ? step >= 2
                    ? '✓ log + memtable'
                    : `t${h.ts} is newer → apply`
                  : `t${h.ts} ≤ local → skip (LWW)`}
            </span>
          </motion.div>
        ))}

        {step >= 3 && (
          <motion.div className="cu-verdict ok" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            ✓ hint trays emptied on the holder{new Set(replays.map((r) => r.fromNode)).size === 1 ? '' : 's'} — {applied} of {replays.length} applied, caught up without any leader involved
          </motion.div>
        )}
      </div>
    )
  }

  return {
    key: `hint-${nodeId}`,
    title: `${nodeId} · hinted handoff, mutation by mutation`,
    sub: `${nodeId} · hint replay`,
    source: `[data-fly="${nodeId}"]`,
    steps,
    Stage,
  }
}
