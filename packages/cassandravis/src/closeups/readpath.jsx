import { motion } from 'framer-motion'
import { NODE_COLORS } from '../cluster'
import { fnv, DictView } from './shared'

const BLOOM_BITS = 16
// Two "hash functions" per key — the same probes flush.jsx sets when it builds
// the filter, so a table's bits here match the bits that table was born with.
const bitsFor = (k) => [fnv(k) % BLOOM_BITS, fnv('probe2:' + k) % BLOOM_BITS]

// Close-up: ONE replica's local read path for `key`, the same order readValue()
// in cluster.js computes — memtable first, then SSTables newest-first, each
// gated by its bloom filter. Unlike readValue's exact-membership stand-in, this
// zoom lets the 16-bit filter answer from its ACTUAL bits, so a rare collision
// shows an honest false positive (read → not there). The winner is unaffected:
// a false positive still finds no entry, so last-write-wins is identical.
export function build(nodeId, node, key, keysMeta) {
  const mem = node.memtable[key] || null
  const memEntries = Object.entries(node.memtable).sort(([a], [b]) => a.localeCompare(b))

  const probe = bitsFor(key)
  // Newest SSTable first — the order a real read consults them.
  const ssts = [...node.sstables].reverse().map((t) => {
    const entries = Object.entries(t.entries).sort(([a], [b]) => a.localeCompare(b))
    const setBits = new Set(Object.keys(t.entries).flatMap((k) => bitsFor(k)))
    const allSet = probe.every((b) => setBits.has(b))
    const zeroBit = probe.find((b) => !setBits.has(b)) // the bit that proves absence
    const stored = t.entries[key] || null
    return {
      id: t.id,
      entries,
      setBits,
      allSet,
      zeroBit,
      read: allSet, // bloom says "maybe" ⇒ we pay for a disk read
      hit: allSet && !!stored, // read AND actually present
      falsePositive: allSet && !stored, // read but absent — a bloom false positive
      entry: allSet ? stored : null,
    }
  })

  // Resolve exactly like readValue: newest ts across the memtable + every table
  // whose bloom let us in and that held the key.
  let best = mem
  let source = mem ? 'memtable' : null
  for (const s of ssts) {
    if (s.entry && (!best || s.entry.ts > best.ts)) {
      best = s.entry
      source = s.id
    }
  }

  const memStep = {
    key: 'mem',
    title: '1 · Check the memtable first',
    blurb: `A replica answers from its own LSM tree, newest source first. The memtable is a sorted in-memory map of key → {value, ts} — looking up ${key} is a direct map lookup, no disk touched. ${
      mem
        ? `${key} is in memory (t${mem.ts}); it holds the newest copy of any key it still has. We still glance at the SSTables to be sure nothing newer lives on disk.`
        : `${key} is not in memory, so the read heads to disk — the immutable SSTables, newest-first.`
    }`,
  }

  const sstSteps = ssts.map((s, i) => ({
    key: `sst-${s.id}`,
    title: `${i + 2} · ${s.id} — ask the bloom filter`,
    blurb: `Before reading ${s.id} off disk, consult its bloom filter: a tiny bit array that every key in the table sets a couple of bits in. ${key}'s bits are {${probe.join(', ')}}. ${
      !s.allSet
        ? `Bit ${s.zeroBit} is 0 — no key ever set it, so ${key} was definitely never written here. Skip the whole file: zero disk reads. A bloom filter is never wrong about "no".`
        : s.hit
          ? `Both are set → "maybe here" → read the table, and there it is (t${s.entry.ts}).`
          : `Both are set → "maybe here" → so we read the table… and ${key} is NOT in it. That's a bloom false positive: other keys happened to set those same bits. Rare, and it only costs one wasted read — never a wrong answer (a bloom never says "no" falsely).`
    }`,
  }))

  const resolveStep = {
    key: 'resolve',
    title: `${ssts.length + 2} · Resolve by newest timestamp`,
    blurb: best
      ? best.tombstone
        ? `Across the memtable and every SSTable that had it, the newest version wins — and it's a tombstone (t${best.ts}, from ${source}). This replica answers "not found": the delete out-timestamps any older value still on disk.`
        : `Across the memtable and every SSTable that had it, the newest timestamp wins — last-write-wins. Winner: ${best.value} (t${best.ts}, from ${source}). That goes back to the coordinator with its timestamp.`
      : `${key} was not in the memtable and every SSTable's bloom filter said "no". Nothing found anywhere → this replica answers "no data".`,
  }

  const steps = [memStep, ...sstSteps, resolveStep]
  const resolveIdx = steps.length - 1

  function Bits({ s }) {
    return (
      <span className="cu-bits">
        {Array.from({ length: BLOOM_BITS }, (_, i) => {
          const set = s.setBits.has(i)
          const isProbe = probe.includes(i)
          const cls =
            'cu-bit' + (set ? ' set' : '') + (isProbe ? (set ? ' probe' : ' probe zero') : '')
          return (
            <span key={i} className={cls}>
              {set ? 1 : 0}
            </span>
          )
        })}
      </span>
    )
  }

  function Stage({ step }) {
    return (
      <div className="cu-rows">
        <div className="cu-banner">
          <span className="node-dot" style={{ background: NODE_COLORS[nodeId] }} />
          <span className="cu-cell">{nodeId} · read path for</span>
          <span className="entry-chip" style={{ background: keysMeta[key]?.color || '#888' }}>
            {key}?
          </span>
        </div>

        {/* memtable — always visible; it is step 1. Drawn as the map it is,
            with the looked-up key's row (or its absence) called out. */}
        <div className={'cu-row block' + (mem ? ' ok' : ' dim')}>
          <DictView
            label="① memtable — a sorted map, in memory"
            note={mem ? `direct lookup: hit → t${mem.ts}` : 'direct lookup: miss'}
            rows={[
              ...memEntries.map(([k, e]) => ({
                k,
                entry: e,
                color: keysMeta[k]?.color,
                state: k === key ? 'focus' : 'dim',
                annotation: k === key ? `hit → t${e.ts}` : undefined,
              })),
              ...(mem
                ? []
                : [{ k: key, color: keysMeta[key]?.color, state: 'miss', annotation: 'not in this map' }]),
            ].sort((a, b) => a.k.localeCompare(b.k))}
            empty="empty — nothing written since the last flush"
          />
        </div>

        {/* one SSTable per step: bloom bits first, then (only if the bloom
            says maybe) the table itself, drawn as the sorted map on disk. */}
        {ssts.map((s, i) =>
          step >= i + 1 ? (
            <motion.div
              key={s.id}
              className={'cu-row block' + (s.hit ? ' ok' : s.read ? '' : ' dim')}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <div className="cu-dict-label">
                🔒 {s.id} — immutable file on disk
                <span className="cu-dict-note">
                  {key}→{'{' + probe.join(',') + '}'} ·{' '}
                  {!s.allSet
                    ? `bit ${s.zeroBit}=0 → skip, no disk read`
                    : s.hit
                      ? `all set → read → hit t${s.entry.ts}`
                      : 'all set → read → not here (false +)'}
                </span>
              </div>
              <Bits s={s} />
              {s.read && (
                <DictView
                  rows={[
                    ...s.entries.map(([k, e]) => ({
                      k,
                      entry: e,
                      color: keysMeta[k]?.color,
                      state: k === key ? 'focus' : 'dim',
                      annotation: k === key ? `hit → t${e.ts}` : undefined,
                    })),
                    ...(s.hit
                      ? []
                      : [{ k: key, color: keysMeta[key]?.color, state: 'miss', annotation: 'bloom false positive — wasted read, right answer' }]),
                  ].sort((a, b) => a.k.localeCompare(b.k))}
                  empty="empty"
                />
              )}
            </motion.div>
          ) : null,
        )}

        {step >= resolveIdx && (
          <motion.div
            className={'cu-verdict' + (best && !best.tombstone ? ' ok' : '')}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
          >
            {best
              ? best.tombstone
                ? `🪦 newest is a tombstone (t${best.ts}, ${source}) → "not found"`
                : `✓ winner: ${key} = ${best.value} (t${best.ts}, from ${source}) → coordinator`
              : `∅ nothing found → "no data"`}
          </motion.div>
        )}
      </div>
    )
  }

  return {
    key: `rp-${nodeId}-${key}`,
    title: `${nodeId} · local read path for ${key}`,
    sub: `${nodeId} · memtable → SSTables`,
    source: `[data-fly="${nodeId}"]`,
    steps,
    Stage,
  }
}
