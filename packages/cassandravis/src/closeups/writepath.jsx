import { motion } from 'framer-motion'
import { NODE_COLORS } from '../cluster'
import { Mut, DictView, sortedEntries } from './shared'

// Close-up: ONE replica's local write path — commit log append, then memtable
// upsert, with the rest of the memtable map and the untouched on-disk SSTables
// shown for context. `prev` is the entry this key shadows in the node's memtable
// (from the cluster as it stood before this op), so the upsert visibly wins by
// timestamp. `baseNode` is the node BEFORE this write; `keysMeta` supplies the
// other entries' display colors.
export function build(p, nodeId, baseNode, verb, keysMeta = {}) {
  const prev = baseNode.memtable[p.key] || null
  const logN = baseNode.commitLog
  // The OTHER keys already living in this memtable — so the map reads as a map,
  // not a single cell. Sorted, like the memtable itself.
  const others = Object.entries(baseNode.memtable)
    .filter(([k]) => k !== p.key)
    .sort(([a], [b]) => a.localeCompare(b))
  const ssts = baseNode.sstables // oldest → newest, immutable, on disk

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
      blurb: `The memtable is a sorted in-memory map — one entry per key, ${others.length + (prev ? 1 : 0)} already here. The write is just one upsert into that map. ${
        prev
          ? `${p.key} already had ${prev.tombstone ? 'a tombstone' : `${prev.value} (t${prev.ts})`}; the new version doesn't erase it in place — t${p.ts} > t${prev.ts} simply wins whenever anyone reads.`
          : `${p.key} is new to the map; the other keys are untouched.`
      }`,
    },
    {
      key: 'disk',
      title: '4 · Nothing reaches disk yet',
      blurb: `The SSTables below are immutable files on disk — the write does NOT touch them. ${
        ssts.length
          ? `${nodeId} has ${ssts.length} of them from earlier flushes.`
          : `${nodeId} has none yet — it hasn't flushed.`
      } A memtable becomes a brand-new SSTable only when it fills up and FLUSHES (its own zoom). Until then this key lives only in memory + the commit log.`,
    },
    {
      key: 'ack',
      title: '5 · Ack the coordinator',
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

        <div className={'cu-row block' + (step >= 2 ? ' ok' : ' dim')}>
          <DictView
            label="memtable — a sorted map, in memory"
            rows={[
              // the rest of the map, in sorted order with the written key slotted in
              ...others.map(([k, e]) => ({
                k,
                entry: e,
                color: keysMeta[k]?.color,
                state: 'dim',
              })),
              ...(prev
                ? [
                    {
                      k: p.key,
                      entry: prev,
                      color: p.color,
                      state: step >= 2 ? 'struck' : 'focus',
                      annotation: step >= 2 ? `shadowed — t${p.ts} > t${prev.ts}` : undefined,
                    },
                  ]
                : []),
              ...(step >= 2
                ? [
                    {
                      k: p.key,
                      entry: { value: p.value, ts: p.ts, tombstone: p.tombstone },
                      color: p.color,
                      state: 'new',
                      annotation: '← this write',
                    },
                  ]
                : []),
            ].sort((a, b) => a.k.localeCompare(b.k) || (a.entry?.ts ?? 0) - (b.entry?.ts ?? 0))}
            empty={`no entries yet — this write starts the map`}
          />
        </div>

        <div className={'cu-sst-strip' + (step === 3 ? ' focus' : '')}>
          <span className="cu-note">on disk · immutable · untouched by this write</span>
          <div className="cu-sst-row">
            {ssts.length === 0 ? (
              <span className="cu-note">no SSTables yet — flush creates the first one</span>
            ) : (
              ssts.map((t) => (
                <DictView
                  key={t.id}
                  label={`🔒 ${t.id} — immutable file on disk`}
                  rows={sortedEntries(t.entries).map(([k, e]) => ({
                    k,
                    entry: e,
                    color: keysMeta[k]?.color,
                    state: 'dim',
                  }))}
                  empty="empty"
                />
              ))
            )}
          </div>
        </div>

        {step >= 4 && (
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
