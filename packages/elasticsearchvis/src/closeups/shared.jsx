import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { blockRange } from '../blocktree'

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
// pointer that some states carry.
//
// Drawn by the convention, not as a teaching diagram: characters live ONLY on
// the arcs, and a state's bubble holds its output — the .tim address — or is
// empty. A state is never labelled with the prefix that reaches it, because a
// prefix is a property of the PATH and minimization can merge states two
// different prefixes reach. We hang outputs on states rather than arcs (see
// buildFst), which makes this a Moore machine, and Moore puts the output in the
// bubble. Lucene's own Util.toDot does the same thing with node ADDRESSES.
//
// `walk` is an fstSeek() result — its arcs are
// drawn as the live path, and a missing arc is drawn as the dead end it is.
// `followed` comes from an automaton intersection instead, and holds ONLY the
// arcs the pattern accepted: a rejected arc is left at its resting grey rather
// than drawn in red, so the picture shows the work done and not the work saved.
//
// `pruned` opts INTO drawing the rejections, for the one case where they are the
// lesson rather than the noise: a fuzzy query, where whether an arc can die at
// all is the whole reason the intersection is cheap. `dimmed` fades the states
// behind those arcs — the terms nobody read — and `cursor` marks where the walk
// is standing right now, so the FST and the automaton beside it move together.
export function ArcGraph({
  fst,
  index,
  walk,
  followed,
  pruned,
  dimmed,
  cursor: cursorState,
  focus: focusState,
  revealed = Infinity,
}) {
  const { pos, width, height } = fstLayout(fst)
  const box = useRef(null)
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

  // The .tip FST is BUSHY, not deep: fstLayout puts depth on x (a handful of
  // columns) and stacks siblings on y, so a dictionary with a hundred terms is
  // a graph a couple of thousand pixels TALL. Rather than let that set the
  // panel's height, the box is capped and pans to wherever the walk currently
  // is — which also reads better, because the eye follows the action instead of
  // hunting for it in a static picture.
  // Pan to the node this step is ABOUT, not to where the walk is standing. They
  // differ exactly where it matters: a pruned arc is reported from the node the
  // walk sits on, and for `sc*` that is the root for sixteen consecutive
  // rejections — so following the cursor left the picture motionless while arcs
  // died all over the graph. `focus` is the arc's far end, which is the thing
  // actually changing. Instant rather than smooth: one decision is a 260ms tick,
  // and a smooth scroll would still be travelling when the next one lands.
  const at = focusState ?? cursorState ?? cursor
  const spot = pos.get(at)
  useEffect(() => {
    const el = box.current
    if (!el || !spot) return
    el.scrollTo({
      top: Math.max(0, Math.min(spot.y - el.clientHeight / 2, el.scrollHeight - el.clientHeight)),
      left: Math.max(0, Math.min(spot.x - el.clientWidth / 2, el.scrollWidth - el.clientWidth)),
      behavior: 'auto',
    })
  }, [spot?.x, spot?.y])

  return (
    <div className="cu-fst" ref={box} style={{ minHeight: Math.min(height, 300) }}>
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
                (s.id === cursorState ? ' cursor' : '') +
                (dimmed?.has(s.id) ? ' dim' : '') +
                (hasOut ? ' has-out' : '')
              }
            >
              <circle cx={p.x} cy={p.y} r={17} />
              {hasOut && (
                <text x={p.x} y={p.y + 4} className="cu-state-out">
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
          an arrow <b>consumes one character</b> · a circle is <b>a node</b>, and an
          address inside one means <b>“a block lives here”</b>
        </span>
        <span><i className="dot has-out" /> carries a .tim block pointer</span>
        <span><i className="dot walked" /> the arrows this query followed · grey was never looked at</span>
        {pruned?.size > 0 && (
          <span><i className="dot pruned" /> rejected — everything behind it is skipped unread</span>
        )}
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

// ---------------------------------------------------------------------------
// The query side — a Levenshtein automaton
// ---------------------------------------------------------------------------

// The (i, e) grid, drawn where the model already put it: a column per character
// of the query term, a ROW PER EDIT SPENT. Nothing here is a layout decision —
// `grid` comes out of buildLevenshteinNfa with coordinates attached, so the
// picture cannot drift from the machine it claims to be.
//
// The one thing this has to get across, and the reason it is not just a second
// ArcGraph: the walk is in a SET of these states at once, not one of them. After
// consuming "car" against "cat~1" the automaton is simultaneously "matched three
// characters, one edit spent" and "matched two, one spent, expecting a t" — and
// which of those survives the NEXT character is the whole game. A single glowing
// node would be a lie.
const LEV_COL = 80
const LEV_ROW = 76
const LEV_R = 17
const LEV_BRIDGE_R = 9

const levPos = (n) => ({ x: 58 + n.i * LEV_COL, y: 44 + n.e * LEV_ROW })

// Pull a segment back from both centers so it starts and ends at the node edges
// rather than under them.
function trim(p1, p2, r1, r2) {
  const dx = p2.x - p1.x
  const dy = p2.y - p1.y
  const len = Math.hypot(dx, dy) || 1
  return {
    x1: p1.x + (dx / len) * r1,
    y1: p1.y + (dy / len) * r1,
    x2: p2.x - (dx / len) * r2,
    y2: p2.y - (dy / len) * r2,
  }
}

// A deletion and a substitution join the SAME two states, so one of them has to
// bow out of the way or they draw on top of each other. The deletion curves,
// which suits it — it is the one transition that consumes no input at all.
function bow(p1, p2, amount) {
  const mx = (p1.x + p2.x) / 2
  const my = (p1.y + p2.y) / 2
  const dx = p2.x - p1.x
  const dy = p2.y - p1.y
  const len = Math.hypot(dx, dy) || 1
  return { cx: mx - (dy / len) * amount, cy: my + (dx / len) * amount }
}

const EDGE_LABEL = { insert: 'any', substitute: 'any', delete: 'ε' }

export function AutomatonGrid({ grid, live, entered, taken, dead, pattern }) {
  if (!grid) return null
  const pos = new Map(grid.nodes.map((n) => [n.id, levPos(n)]))
  const width = 58 + grid.n * LEV_COL + 44
  const height = 44 + grid.maxEdits * LEV_ROW + 52
  const liveSet = live ?? new Set()
  const enteredSet = entered ?? new Set()
  const takenSet = taken ?? new Set()
  const pinned = grid.prefixLength

  return (
    <div className={'cu-lev' + (dead ? ' dead' : '')} style={{ minHeight: height }}>
      <svg width={width} height={height} className="cu-lev-svg">
        {/* The pinned prefix, as a band rather than a caption: inside it there
            are no edit edges at all, and seeing that absence is the point. */}
        {pinned > 0 && (
          <g className="cu-lev-pin">
            <rect
              x={32}
              y={18}
              width={pinned * LEV_COL + 6}
              height={height - 46}
              rx={10}
            />
            <text x={36} y={height - 30}>
              first {pinned} character{pinned === 1 ? '' : 's'} pinned — no edit may happen in here
            </text>
          </g>
        )}

        {/* One gutter label per edit layer, so dropping into the next one reads
            as an event and not as the walk merely moving. */}
        {Array.from({ length: grid.maxEdits + 1 }, (_, e) => (
          <text key={'lay' + e} className="cu-lev-layer" x={8} y={38 + e * LEV_ROW + 4}>
            {e === 0 ? '0 edits' : `${e} edit${e === 1 ? '' : 's'}`}
          </text>
        ))}

        {grid.edges.map((ed, k) => {
          const p1 = pos.get(ed.from)
          const p2 = pos.get(ed.to)
          if (!p1 || !p2) return null
          const r1 = grid.nodes.find((n) => n.id === ed.from)?.bridge ? LEV_BRIDGE_R : LEV_R
          const r2 = grid.nodes.find((n) => n.id === ed.to)?.bridge ? LEV_BRIDGE_R : LEV_R
          const isTaken = takenSet.has(`${ed.from}:${ed.to}:${ed.kind}`)
          const cls = 'cu-lev-edge ' + ed.kind + (isTaken ? ' taken' : '')
          // Edit edges are told apart by how they are DRAWN (see the legend);
          // they only caption themselves at the moment they fire. Labelling all
          // of them at rest buried the grid under thirty tiny words.
          const always = ed.kind === 'match'
          const label = always || isTaken
            ? (ed.kind === 'match' || ed.kind === 'transpose' ? ed.label : EDGE_LABEL[ed.kind])
            : null

          if (ed.kind === 'delete') {
            const t = trim(p1, p2, r1, r2)
            const c = bow({ x: t.x1, y: t.y1 }, { x: t.x2, y: t.y2 }, 22)
            return (
              <g key={k} className={cls}>
                <path d={`M ${t.x1} ${t.y1} Q ${c.cx} ${c.cy} ${t.x2} ${t.y2}`} fill="none" />
                {label && <text x={c.cx} y={c.cy + 4}>{label}</text>}
              </g>
            )
          }

          const t = trim(p1, p2, r1, r2)
          const mx = (t.x1 + t.x2) / 2
          const my = (t.y1 + t.y2) / 2
          return (
            <g key={k} className={cls}>
              <line x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} />
              {label && (
                <text x={mx + (ed.kind === 'insert' ? 14 : 0)} y={my - 6}>{label}</text>
              )}
            </g>
          )
        })}

        {grid.nodes.map((n) => {
          const p = pos.get(n.id)
          return (
            <g
              key={n.id}
              className={
                'cu-lev-state' +
                (n.bridge ? ' bridge' : '') +
                (n.accept ? ' accept' : '') +
                (liveSet.has(n.id) ? ' live' : '') +
                (enteredSet.has(n.id) ? ' entered' : '')
              }
            >
              {n.accept && !n.bridge && (
                <circle cx={p.x} cy={p.y} r={LEV_R + 4} className="cu-lev-ring" />
              )}
              <circle cx={p.x} cy={p.y} r={n.bridge ? LEV_BRIDGE_R : LEV_R} />
              {!n.bridge && (
                <text x={p.x} y={p.y + 4} className="cu-lev-tag">
                  {n.i},{n.e}
                </text>
              )}
            </g>
          )
        })}
      </svg>

      <div className="cu-lev-legend">
        <span className="cu-lev-key">
          a state is <b>(characters matched, edits spent)</b> · going <b>right</b> is
          a character that was right, going <b>down</b> costs an edit
        </span>
        <span><i className="dot live" /> alive right now — the walk is in all of them at once</span>
        <span><i className="dot accept" /> accepting: “{pattern?.literal}” is reachable from here within budget</span>
        <span className="cu-lev-edges">
          <i className="edge match" /> the expected character
          <i className="edge insert" /> an extra one
          <i className="edge substitute" /> a wrong one
          <i className="edge delete" /> a missing one
          {grid.transpositions && <><i className="edge transpose" /> two swapped</>}
        </span>
        <span className="cu-lev-size">
          {grid.nodes.length} states for {grid.maxEdits} edit
          {grid.maxEdits === 1 ? '' : 's'} on {grid.n} characters
          {grid.transpositions ? ' · small nodes are transposition bridges' : ''}
        </span>
      </div>
    </div>
  )
}
