import { motion } from 'framer-motion'
import { NODE_COLORS } from '../cluster'
import { Mut } from './shared'

// Close-up: the coordinator turning divergent read responses into read-repair
// writes. Data: the get payload — { key, color, responses, winner, repairs }.
export function build(p) {
  const fmt = (e) =>
    e ? (e.tombstone ? `tombstone · t${e.ts}` : `${e.value} · t${e.ts}`) : 'no data'
  const steps = [
    {
      key: 'compare',
      title: '1 · The responses disagree',
      blurb: `The contacted replicas answered with different versions: ${p.responses
        .map((x) => `${x.node} → ${fmt(x.entry)}`)
        .join(' · ')}. The coordinator lines them up by timestamp — the newest one (t${p.winner.ts}) is the truth as far as last-write-wins is concerned.`,
    },
    {
      key: 'build',
      title: '2 · The repair mutation keeps the WINNING timestamp',
      blurb: `The fix is just a write of the winning version — crucially, with its ORIGINAL timestamp t${p.winner.ts}, not a new one. Read repair invents nothing: if it stamped a fresh timestamp, it could beat a legitimate newer write racing in from elsewhere.`,
    },
    {
      key: 'send',
      title: '3 · Write back to the stale replicas',
      blurb: `The winner is written to ${p.repairs.join(' and ')} through the normal write path. Only the replicas THIS read contacted get healed — an uncontacted stale replica stays stale until a future read, a hint, or anti-entropy repair finds it.`,
    },
  ]

  function Stage({ step }) {
    return (
      <div className="cu-rows">
        {p.responses.map((x, i) => {
          const isWinner = x.entry && x.entry.ts === p.winner.ts
          const isStale = p.repairs.includes(x.node)
          return (
            <motion.div
              key={x.node}
              className={'cu-row' + (isWinner ? ' ok' : isStale ? ' bad' : '')}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.15 }}
            >
              <span className="node-dot" style={{ background: NODE_COLORS[x.node] }} />
              <span className="cu-cell">{x.node}</span>
              <span className="cu-cell mono">{fmt(x.entry)}</span>
              <span className="cu-cell right">
                {isWinner ? '← newest (wins)' : isStale ? (step >= 2 ? '✓ repaired' : 'STALE') : ''}
              </span>
            </motion.div>
          )
        })}

        {step >= 1 && (
          <motion.div className="cu-banner" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <span className="cu-note">repair mutation:</span>
            <Mut
              k={p.key}
              value={p.winner.value}
              ts={p.winner.ts}
              tombstone={p.winner.tombstone}
              color={p.color}
            />
            <span className="cu-note">same t{p.winner.ts} — no new timestamp</span>
          </motion.div>
        )}

        {step >= 2 && (
          <motion.div className="cu-verdict ok" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            ✓ {p.repairs.join(', ')} healed before the client is answered — reads quietly repair
            what they touch
          </motion.div>
        )}
      </div>
    )
  }

  return {
    key: `rr-${p.key}`,
    title: `Coordinator · read repair for ${p.key}`,
    sub: 'coordinator · read repair',
    source: '[data-fly="node-1"]',
    steps,
    Stage,
  }
}
