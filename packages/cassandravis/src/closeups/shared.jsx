// Small pieces shared by the close-up stages.

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
