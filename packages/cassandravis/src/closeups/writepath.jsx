import { motion } from 'framer-motion'
import { NODE_COLORS } from '../cluster'
import { Mut } from './shared'

// Close-up: ONE replica's local write path — commit log append, then memtable
// upsert. `prev` is the entry this key shadows in the node's memtable (from the
// cluster as it stood before this op), so the upsert visibly wins by timestamp.
export function build(p, nodeId, baseNode, verb) {
  const prev = baseNode.memtable[p.key] || null
  const logN = baseNode.commitLog
  const steps = [
    {
      key: 'arrive',
      title: '1 · The mutation arrives',
      blurb: `${nodeId} receives the ${verb === 'del' ? 'tombstone' : 'mutation'} from the coordinator, timestamp already attached (t${p.ts}). A replica never re-decides anything about the write — it just stores it.`,
    },
    {
      key: 'log',
      title: '2 · Append to the commit log',
      blurb: 'First stop: the commit log — a sequential, append-only file that is fsynced. If this node crashes a millisecond from now, the mutation survives and replays into a fresh memtable on restart. Appends are why LSM writes are fast: no seeks, no read-before-write.',
    },
    {
      key: 'mem',
      title: '3 · Upsert the memtable',
      blurb: prev
        ? `The in-memory memtable (a sorted map) gets the new version. The old ${prev.tombstone ? 'tombstone' : `value (${prev.value}, t${prev.ts})`} is shadowed — not because it was "overwritten in place", but because t${p.ts} > t${prev.ts} whenever anyone reads.`
        : 'The in-memory memtable (a sorted map) gets the entry. Nothing on disk is touched — SSTables are immutable; this key reaches disk only when the memtable flushes.',
    },
    {
      key: 'ack',
      title: '4 · Ack the coordinator',
      blurb: 'Log appended + memtable updated = this replica is done, and it says so. Whether the CLIENT gets a success depends on how many of these acks the coordinator collects versus W — that decision lives with the coordinator, not here.',
    },
  ]

  function Stage({ step }) {
    return (
      <div className="cu-rows">
        <div className="cu-banner">
          <span className="node-dot" style={{ background: NODE_COLORS[nodeId] }} />
          <span className="cu-cell">{nodeId}</span>
          <Mut k={p.key} value={p.value} ts={p.ts} tombstone={p.tombstone} color={p.color} />
          <span className="cu-note">from coordinator</span>
        </div>

        <div className={'cu-row' + (step >= 1 ? ' ok' : ' dim')}>
          <span className="cu-cell">commit log (append-only)</span>
          <span className="cu-cell mono dim">…{logN} earlier entr{logN === 1 ? 'y' : 'ies'}…</span>
          {step >= 1 && (
            <motion.span
              className="cu-cell mono right"
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
            >
              + #{logN + 1}: {p.tombstone ? `🪦 ${p.key}` : `${p.key}=${p.value}`} t{p.ts} · fsync ✓
            </motion.span>
          )}
        </div>

        <div className={'cu-row' + (step >= 2 ? ' ok' : ' dim')}>
          <span className="cu-cell">memtable (sorted, in memory)</span>
          <span className="cu-cell chips">
            {prev && (
              <Mut
                k={p.key}
                value={prev.value}
                ts={prev.ts}
                tombstone={prev.tombstone}
                color={p.color}
                struck={step >= 2}
              />
            )}
            {step >= 2 && (
              <motion.span initial={{ opacity: 0, scale: 0.7 }} animate={{ opacity: 1, scale: 1 }}>
                <Mut k={p.key} value={p.value} ts={p.ts} tombstone={p.tombstone} color={p.color} />
              </motion.span>
            )}
            {!prev && step < 2 && <span className="cu-note">no entry for {p.key} yet</span>}
          </span>
        </div>

        {step >= 3 && (
          <motion.div className="cu-verdict ok" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            ✓ ack → coordinator — this replica's part is done; W is the coordinator's problem
          </motion.div>
        )}
      </div>
    )
  }

  return {
    key: `wp-${nodeId}-${p.ts}`,
    title: `${nodeId} · local write path for ${p.key}`,
    sub: `${nodeId} · commit log → memtable`,
    source: `[data-fly="${nodeId}"]`,
    steps,
    Stage,
  }
}
