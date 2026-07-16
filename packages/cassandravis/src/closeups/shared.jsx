import { motion } from 'framer-motion'

// Small pieces shared by the close-up stages.

// A memtable/SSTable drawn as what it IS: a map. Braces on their own lines,
// one sorted `"key" → { value, ts }` row per entry. The storage zooms
// (write path, read path, flush) all render through this so "it's a
// dictionary" is something you see, not something a blurb asserts.
//   rows: [{ k, entry: {value, ts, tombstone}, color, state?, annotation? }]
//   state: undefined | 'dim' | 'struck' | 'new' | 'focus' | 'miss'
//     dim    — context entry, not part of this step's story
//     struck — shadowed old version
//     new    — pops in (framer) — a fresh upsert
//     focus  — the key being looked up (found)
//     miss   — the key being looked up, absent: ghosted `"key" → ∅`
// Callers pass rows already sorted by key — the sortedness IS the lesson.
export function DictView({ label, note, rows, empty }) {
  return (
    <div className="cu-dict">
      {label && (
        <div className="cu-dict-label">
          {label}
          {note && <span className="cu-dict-note">{note}</span>}
        </div>
      )}
      <div className="cu-dict-brace">{'{'}</div>
      {rows.length === 0 ? (
        <div className="cu-dict-row dim">
          <span className="cu-dict-note">{empty ?? 'empty'}</span>
        </div>
      ) : (
        rows.map((r) => {
          const Row = r.state === 'new' ? motion.div : 'div'
          const anim =
            r.state === 'new'
              ? { initial: { opacity: 0, scale: 0.8, x: -6 }, animate: { opacity: 1, scale: 1, x: 0 } }
              : {}
          return (
            <Row key={`${r.k}-${r.entry?.ts ?? 'miss'}-${r.state ?? ''}`} className={'cu-dict-row' + (r.state ? ' ' + r.state : '')} {...anim}>
              <span className="cu-dict-key" style={{ color: r.color || undefined }}>
                "{r.k}"
              </span>
              <span className="cu-dict-arrow">→</span>
              {r.state === 'miss' ? (
                <span className="cu-dict-val">∅ (no such key)</span>
              ) : (
                <span className="cu-dict-val">
                  {'{ '}
                  {r.entry.tombstone ? '🪦 tombstone' : `"${r.entry.value}"`}, t{r.entry.ts}
                  {' }'}
                </span>
              )}
              {r.annotation && <span className="cu-dict-ann">{r.annotation}</span>}
            </Row>
          )
        })
      )}
      <div className="cu-dict-brace">{'}'}</div>
    </div>
  )
}

// Sorted [key, entry] pairs of a memtable/SSTable `entries` object — the order
// a sorted map keeps and a DictView shows.
export const sortedEntries = (entries) =>
  Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))

// An entry chip in the same visual language as the stage's memtable/SSTable
// chips: `key=value` (or a tombstone) plus its timestamp.
export function Mut({ k, value, ts, tombstone, color, struck }) {
  return (
    <span
      className={
        'entry-chip' + (tombstone ? ' tombstone' : '') + (struck ? ' cu-struck' : '')
      }
      style={tombstone ? undefined : { background: color || '#888' }}
    >
      {tombstone ? `🪦 ${k}` : `${k}=${value}`}
      <span className="ts">t{ts}</span>
    </span>
  )
}

// FNV-style short hash — same shape as MerkleView's, exported here so several
// close-ups (merkle trees, bloom bits) can derive stable fake-but-deterministic
// values from strings.
export function fnv(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 16777619) >>> 0
  return h
}
export const hex4 = (n) => n.toString(16).slice(0, 4)
