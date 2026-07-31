import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { blockRange, statePrefixes } from '../blocktree'

// Small pieces shared by the on-disk close-up stages. These render the models in
// src/blocktree.js, src/postings.js and src/automaton.js, so anything that
// asserts a number here should be reading it from the model rather than being
// written into copy.

// Reveal `total` units, one every `ms`, while `on` — the stepped replay every
// on-disk stage uses (FST arcs, in-block suffix rows, postings walks, DFA
// verdicts). Jumps straight to the end when off, so scrubbing away and back never
// leaves a half-played animation, and a nested close-up covering the panel (which
// clears `active`) parks it at "finished" rather than ticking unseen.
export function useReveal(on, total, ms) {
  const [n, setN] = useState(total)
  useEffect(() => {
    if (!on) {
      setN(total)
      return
    }
    let i = 0
    setN(0)
    const id = setInterval(() => {
      i += 1
      setN(i)
      if (i >= total) clearInterval(id)
    }, ms)
    return () => clearInterval(id)
  }, [on, total, ms])
  return n
}

// Every panel that shrinks a real Lucene constant carries one of these, so the
// toy scale can never be mistaken for the real thing.
export function ToyBadge({ here, lucene, what }) {
  return (
    <span className="cu-toy" title="This visualization uses a smaller constant so the structure fits on screen. The algorithm is unchanged.">
      {what} <b>{here}</b> here · <b>{lucene}</b> in Lucene
    </span>
  )
}

// A cost line: the honest number the step is really about.
export function CostLine({ children, tone }) {
  return <div className={'cu-cost' + (tone ? ' ' + tone : '')}>{children}</div>
}

export function SectionLabel({ children, note }) {
  return (
    <div className="cu-label">
      {children}
      {note && <span className="cu-label-note">{note}</span>}
    </div>
  )
}

// The four hops a lookup makes, as a "you are here" strip pinned above every
// on-disk stage. Answering a query means following ALL of these in order, and
// each one answers a different question — the chain is easy to collapse
// otherwise (".tip points at the document" is the natural wrong guess, because
// nothing draws the difference between "which docs" and "the text").
// `shown: false` marks a hop this zoom never opens — it is downstream of what is
// on screen. Keeping it visible is the point: it is the only thing distinguishing
// ".doc — which documents" from ".fdt — the text", which is exactly the pair a
// reader collapses when the chain isn't drawn.
const CHAIN = [
  { ext: '.tip', q: 'which block?', where: 'RAM', shown: true },
  { ext: '.tim', q: 'which term?', where: 'disk', shown: true },
  { ext: '.doc', q: 'which docs?', where: 'disk', shown: false },
  { ext: '.fdt', q: 'the text', where: 'disk', shown: false },
]

export function FileChain({ active }) {
  return (
    <div className="cu-chain">
      <span className="cu-chain-lead">you are here</span>
      <span className="cu-chain-hops">
        {CHAIN.map((h, i) => (
          <span key={h.ext} className="cu-chain-item">
            {i > 0 && <span className="cu-chain-arrow">→</span>}
            <span
              className={
                'cu-chain-hop' +
                (h.ext === active ? ' active' : '') +
                (h.shown ? '' : ' downstream')
              }
            >
              <b>{h.ext}</b>
              <i>{h.q}</i>
            </span>
          </span>
        ))}
      </span>
      <span className="cu-chain-where">
        <span className="ram">in memory</span>
        <span className="disk">on disk</span>
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// .tim — the block tree
// ---------------------------------------------------------------------------

// Every block in the segment as one compact row, so the FST beside it is visibly
// pointing INTO something. The block a seek lands on expands in place into its
// full suffix rows; the rest stay one line each and visibly untouched — which is
// the cost lesson (one of N is read) without spending a step on it.
// `focusFp` marks the single block a term lookup landed on. `loadedFps` is the
// multi-block equivalent for a pattern, which can reach several — pass one or the
// other; both dim everything they don't name, which is the cost lesson.
export function BlockColumn({ index, focusFp, expandedFp, loadedFps, scan, revealed }) {
  const reached = (fp) => (loadedFps ? loadedFps.has(fp) : fp === focusFp)
  const anyReached = !!loadedFps || focusFp != null
  return (
    <div className="cu-bcol">
      {index.blocks.map((b) => {
        const range = blockRange(index, b)
        const expanded = b.fp === expandedFp
        return (
          <div
            key={b.fp}
            className={
              'cu-bcol-item' +
              (anyReached && reached(b.fp) ? ' focus' : '') +
              (anyReached && !reached(b.fp) ? ' unread' : '') +
              (expanded ? ' expanded' : '')
            }
          >
            <div className="cu-bcol-row" data-block-fp={b.fp}>
              <span className="cu-bcol-name">
                {b.prefix ? <>“{b.prefix}…”</> : 'contents'}
              </span>
              <span className="cu-bcol-count">{range ? range.count : 0} terms</span>
              <span className="cu-bcol-fp">{hex(b.fp)}</span>
            </div>
            {expanded && (
              <div className="cu-bcol-open">
                <SuffixBlock block={b} scan={scan} revealed={revealed} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

const hex = (fp) => '0x' + fp.toString(16).toUpperCase().padStart(3, '0')
export { hex as hexAddr }

// ONE block opened up: the shared prefix stored once, then a suffix per entry.
// `scan` is a blockScan() result, so the rows light up in the order the scan
// actually read them and stop where it stopped.
export function SuffixBlock({ block, scan, revealed = Infinity }) {
  const readIx = new Map((scan?.rows || []).map((r, i) => [r.i, { ...r, order: i }]))
  return (
    <div className="cu-suffix-block">
      <div className="cu-suffix-head">
        <span className="cu-block-fp">{hex(block.fp)}</span>
        <span className="cu-suffix-prefix">
          {block.prefix ? (
            <>
              every term in here starts with <b>“{block.prefix}”</b> — so it is
              written once, at the top, instead of on every row
            </>
          ) : (
            <>the contents page — its terms share no common start</>
          )}
        </span>
        <span className="cu-block-count">
          {block.entries.length} entries · {block.bytes}B
          {block.bytesUncompressed > block.bytes && (
            <i className="cu-was"> (was {block.bytesUncompressed}B in full)</i>
          )}
        </span>
      </div>
      <div className="cu-suffix-rows">
        {block.entries.map((e, i) => {
          const r = readIx.get(i)
          const shown = r && r.order < revealed
          return (
            <div
              key={e.kind === 'term' ? e.term : 'sub-' + e.suffix}
              className={
                'cu-suffix-row' +
                (shown ? ' read' : '') +
                (shown && r.hit ? ' hit' : '') +
                (shown && r.stop ? ' stop' : '') +
                (scan && !shown ? ' untouched' : '')
              }
            >
              <span className="cu-suffix-cell prefix">{block.prefix}</span>
              <span className="cu-suffix-cell suffix">{e.suffix}</span>
              {/* Spell the reconstruction out rather than leaving the reader to
                  infer that the two cells to the left concatenate. */}
              <span className="cu-suffix-cell equals">
                = <b>{e.kind === 'term' ? e.term : block.prefix + e.suffix + '…'}</b>
              </span>
              {e.kind === 'term' ? (
                <>
                  <span className="cu-suffix-cell meta">docFreq {e.docFreq}</span>
                  <span className="cu-suffix-cell meta dim">→ .doc</span>
                </>
              ) : (
                <span className="cu-suffix-cell meta sub">
                  sub-block → {hex(e.subFp)} ({e.count} terms)
                </span>
              )}
              {shown && r.hit && <span className="cu-suffix-flag">← found</span>}
              {shown && r.stop && (
                <span className="cu-suffix-flag stop">← past it, stop</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// .tip — the FST
// ---------------------------------------------------------------------------

// Lay the FST out in columns by distance from the root, so the arc walk reads
// left to right. Pure geometry over the model; no layout library.
function fstLayout(fst) {
  const depth = new Map([[fst.root, 0]])
  const queue = [fst.root]
  while (queue.length) {
    const id = queue.shift()
    for (const a of fst.states[id].arcs)
      if (!depth.has(a.to)) {
        depth.set(a.to, depth.get(id) + 1)
        queue.push(a.to)
      }
  }
  const cols = new Map()
  for (const [id, d] of [...depth.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    if (!cols.has(d)) cols.set(d, [])
    cols.get(d).push(id)
  }
  const COL = 108
  const ROW = 46
  const pos = new Map()
  const maxRows = Math.max(...[...cols.values()].map((c) => c.length))
  for (const [d, ids] of cols)
    ids.forEach((id, i) => {
      const span = (maxRows - ids.length) / 2
      pos.set(id, { x: 34 + d * COL, y: 26 + (i + span) * ROW })
    })
  return { pos, width: 34 + cols.size * COL, height: 40 + maxRows * ROW }
}

// The term index as the automaton it is: states, labelled arcs, and the file
// pointer that some states carry. `walk` is an fstSeek() result — its arcs are
// drawn as the live path, and a missing arc is drawn as the dead end it is.
// `prunedArcs` / `followedArcs` come from an automaton intersection instead.
export function ArcGraph({ fst, index, walk, followed, pruned, revealed = Infinity }) {
  const { pos, width, height } = fstLayout(fst)
  // A state MEANS "the letters spelled so far" — label it that way. The raw ids
  // are assigned by minimization's post-order renumbering, so the start state
  // gets the highest one and a walk appears to run 9 → 7 → 6.
  const prefixes = statePrefixes(fst)
  const label = (id) => {
    const p = prefixes[id]
    if (p == null) return String(id) // shared by several prefixes: no honest label
    return p === '' ? 'start' : p
  }
  const walked = new Set()
  const walkedArcs = new Set()
  let cursor = fst.root
  if (walk) {
    walked.add(fst.root)
    walk.arcs.slice(0, revealed).forEach((a) => {
      if (a.missing) return
      walkedArcs.add(`${a.from}:${a.label}`)
      walked.add(a.to)
      cursor = a.to
    })
  }
  const missing = walk?.arcs.slice(0, revealed).find((a) => a.missing)

  return (
    <div className="cu-fst" style={{ minHeight: height }}>
      <svg width={width} height={height} className="cu-fst-svg">
        {fst.states.flatMap((s) =>
          s.arcs.map((a) => {
            const p1 = pos.get(s.id)
            const p2 = pos.get(a.to)
            if (!p1 || !p2) return null
            const key = `${s.id}:${a.label}`
            const cls = walkedArcs.has(key)
              ? 'walked'
              : followed?.has(key)
              ? 'followed'
              : pruned?.has(key)
              ? 'pruned'
              : ''
            return (
              <g key={key} className={'cu-arc ' + cls}>
                <line x1={p1.x + 15} y1={p1.y} x2={p2.x - 15} y2={p2.y} />
                <text x={(p1.x + p2.x) / 2} y={(p1.y + p2.y) / 2 - 5}>
                  {a.label}
                </text>
              </g>
            )
          }),
        )}
        {fst.states.map((s) => {
          const p = pos.get(s.id)
          if (!p) return null
          const hasOut = s.out != null
          return (
            <g
              key={s.id}
              className={
                'cu-state' +
                (walked.has(s.id) ? ' walked' : '') +
                (s.id === cursor && walk ? ' cursor' : '') +
                (hasOut ? ' has-out' : '')
              }
            >
              <circle cx={p.x} cy={p.y} r={17} />
              <text x={p.x} y={p.y + 4} className="cu-state-id">
                {label(s.id)}
              </text>
              {hasOut && (
                <text x={p.x} y={p.y + 30} className="cu-state-out">
                  {hex(s.out)}
                </text>
              )}
            </g>
          )
        })}
        {missing && (() => {
          const p = pos.get(missing.from ?? cursor) || pos.get(cursor)
          return p ? (
            <g className="cu-arc dead">
              <line x1={p.x + 15} y1={p.y} x2={p.x + 62} y2={p.y} />
              <text x={p.x + 38} y={p.y - 8}>
                {missing.label}
              </text>
              <text x={p.x + 70} y={p.y + 4} className="cu-dead-x">
                ✗
              </text>
            </g>
          ) : null
        })()}
      </svg>
      <div className="cu-fst-legend">
        <span className="cu-fst-key">
          a circle is <b>the letters spelled so far</b> · an arrow <b>consumes one
          character</b> · an address under a circle means <b>“a block lives here”</b>
        </span>
        <span><i className="dot has-out" /> carries a .tim block pointer</span>
        <span><i className="dot walked" /> the path this seek took</span>
        <span className="cu-fst-size">
          {fst.fstStates} states
          {fst.trieStates > fst.fstStates
            ? ` (a plain trie needed ${fst.trieStates} — minimizing saved ${fst.trieStates - fst.fstStates})`
            : ' — nothing merged at this size; minimizing is what keeps a real .tip in memory'}
        </span>
      </div>
    </div>
  )
}
