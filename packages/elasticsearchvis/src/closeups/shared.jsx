import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { blockRange } from '../blocktree'

// Small pieces shared by the on-disk close-up stages. These render the models in
// src/blocktree.js and src/automaton.js (the postings and stored-fields tiles in
// stages/segment.jsx render src/postings.js and src/storedFields.js), so
// anything that asserts a number here should be reading it from the model
// rather than being written into copy.

// Reveal `total` units, one every `ms`, while `on` — the stepped replay every
// on-disk stage uses (FST arcs, in-block suffix rows, postings walks, DFA
// verdicts). Jumps straight to `rest` when off (the end, by default), so
// scrubbing away and back never leaves a half-played animation, and a nested
// close-up covering the panel (which clears `active`) parks it at "finished"
// rather than ticking unseen. A replay whose step hasn't ARRIVED yet passes
// `rest: 0` instead, so it rests unstarted rather than finished.
export function useReveal(on, total, ms, rest = total) {
  const [n, setN] = useState(rest)
  useEffect(() => {
    if (!on) {
      setN(rest)
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
  }, [on, total, ms, rest])
  return n
}

// Bring `target` (a selector) into view inside the segment close-up's tile
// panel — the scroller a dived-into tile sits in. Deferred a frame: the tile
// body's effect fires the instant the camera reports it has landed, which can
// still be a hair before the spring has settled or the content has laid out,
// and measuring then scrolls by the wrong amount (or by nothing). `centre`
// scrolls only when the target is outside the box, and centres it there.
export function scrollTileTo(from, target, { centre = false } = {}) {
  const el = from?.closest?.('.seg-tile-panel')
  if (!el) return
  const id = requestAnimationFrame(() => {
    const t = typeof target === 'string' ? el.querySelector(target) : target
    if (!t) return
    const r = t.getBoundingClientRect()
    const b = el.getBoundingClientRect()
    if (centre) {
      if (r.top >= b.top && r.bottom <= b.bottom) return
      el.scrollTop += r.top - b.top - b.height / 2 + r.height / 2
    } else el.scrollTop += r.top - b.top - 12
  })
  return () => cancelAnimationFrame(id)
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
// `expandedFps` opens blocks in place on the read step — the ones whose rows got
// compared — with `scans` (fp → a blockScan-shaped {rows}) driving the per-row
// reveal, ordered by `revealed` (a GLOBAL counter: rows carry their own `order`
// when several blocks replay in sequence). `postings` (src/postings.js) lets an
// opened row print the real .doc address its term points at.
//
// Every block row is ALSO click-to-open: the replay shows which block the walk
// read, but a reader poking at the picture can crack any address open and see
// the terms inside it (all rows, no scan highlight). A manually opened block
// carries `.manual` so it reads as "you opened this", not "the walk did".
export function BlockColumn({ index, focusFp, expandedFps, loadedFps, scans, revealed, postings }) {
  const reached = (fp) => (loadedFps ? loadedFps.has(fp) : fp === focusFp)
  const anyReached = !!loadedFps || focusFp != null
  const [manual, setManual] = useState(() => new Set())
  const toggle = (fp) =>
    setManual((prev) => {
      const next = new Set(prev)
      next.has(fp) ? next.delete(fp) : next.add(fp)
      return next
    })
  return (
    <div className="cu-bcol">
      {index.blocks.map((b) => {
        const range = blockRange(index, b)
        const byReplay = !!expandedFps?.has(b.fp)
        const byHand = manual.has(b.fp)
        const open = byReplay || byHand
        return (
          <div
            key={b.fp}
            className={
              'cu-bcol-item' +
              (anyReached && reached(b.fp) ? ' focus' : '') +
              (anyReached && !reached(b.fp) ? ' unread' : '') +
              (open ? ' expanded' : '') +
              (byHand && !byReplay ? ' manual' : '')
            }
          >
            <button
              type="button"
              className="cu-bcol-row"
              data-block-fp={b.fp}
              aria-expanded={open}
              title={open ? 'Hide this block' : 'Open this block'}
              onClick={() => toggle(b.fp)}
            >
              <span className="cu-bcol-caret">{open ? '▾' : '▸'}</span>
              <span className="cu-bcol-name">
                {b.prefix ? <>“{b.prefix}…”</> : 'contents'}
              </span>
              <span className="cu-bcol-count">{range ? range.count : 0} terms</span>
              <span className="cu-bcol-fp">{hex(b.fp)}</span>
            </button>
            {open && (
              <div className="cu-bcol-open">
                <SuffixBlock
                  block={b}
                  scan={byReplay ? scans?.get(b.fp) : undefined}
                  revealed={byReplay ? revealed : Infinity}
                  postings={postings}
                />
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
// actually read them and stop where it stopped. A row may carry its own `order`
// (a global position across several blocks replaying in sequence); rows without
// one are ordered as they come, which is what a single-block scan wants.
export function SuffixBlock({ block, scan, revealed = Infinity, postings }) {
  const readIx = new Map((scan?.rows || []).map((r, i) => [r.i, { ...r, order: r.order ?? i }]))
  const untouched = scan ? block.entries.length - readIx.size : 0
  return (
    <div className="cu-suffix-block">
      <div className="cu-suffix-head">
        <span className="cu-block-fp">{hex(block.fp)}</span>
        <span className="cu-suffix-prefix">
          {block.prefix ? (
            <>
              every term in here starts with <b>“{block.prefix}”</b>
            </>
          ) : (
            <>the contents page — its terms share no common start</>
          )}
        </span>
        <span className="cu-block-count">
          {block.entries.length} entries · {block.bytes}B
          {block.bytesUncompressed > block.bytes}
        </span>
      </div>
      {/* Why the greyed rows are grey. A block scan is a linear walk in sorted
          order that stops at the term or at the first entry past it (Lucene's
          scanToTermLeaf), so the rows below the stop are never compared — and
          without saying so the picture reads as "all four were checked", which
          is what the row count beneath it would then contradict. */}
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
                  {/* A per-term statistic that lives HERE, in the term row's
                      metadata — not in the posting list. Storing it means a
                      scorer (BM25's IDF needs it) never has to walk .doc to
                      count. */}
                  <span
                    className="cu-suffix-cell meta"
                    title="documents containing this term — stored in the .tim term metadata, alongside the .doc pointer"
                  >
                    docFreq {e.docFreq}
                  </span>
                  {/* The hop the next tile opens at: the term's posting list
                      lives at this address in .doc. */}
                  <span className="cu-suffix-cell meta dim">
                    → .doc{postings?.byTerm.get(e.term) ? ` ${hex(postings.byTerm.get(e.term).fp)}` : ''}
                  </span>
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

// How far a matched-term label sits from its node, and roughly how wide one
// character of it is — used both to place the label and to widen the canvas so a
// label on the last column isn't clipped.
const HIT_GAP = 23
const HIT_CH = 6.4

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
// ONE replay, one set of rules, whatever the query (see SPEC.md): `followed`
// holds the arcs the walk accepted (green), `pruned` the arcs it refused on
// sight (red) — every term behind a pruned arc is skipped unread, and `dimmed`
// fades the states behind them to say so. A plain term drives this exactly like
// a pattern does: it is the degenerate automaton with one acceptable reading,
// so one path survives and every sibling arc dies. `cursor` marks where the
// walk is standing right now, so the FST and the automaton beside it (fuzzy
// mode) move together, and `focus` is the node the current decision is ABOUT —
// the pan target.
export function ArcGraph({
  fst,
  index,
  followed,
  pruned,
  dimmed,
  cursor: cursorState,
  focus: focusState,
  matches,
}) {
  const { pos, width, height } = fstLayout(fst)
  const box = useRef(null)

  // Matched words sit to the RIGHT of their node, not under it: rows are 46px
  // apart and columns 108px, so below is the cramped direction and a label there
  // collides with the next node down. The canvas has to grow to fit a label on
  // the last column, or it gets clipped instead.
  const hitLabel = (terms) =>
    terms.length > 2 ? `${terms[0]} +${terms.length - 1}` : terms.join(', ')
  let svgWidth = width
  for (const [id, terms] of matches ?? []) {
    const p = pos.get(id)
    if (p) svgWidth = Math.max(svgWidth, p.x + HIT_GAP + hitLabel(terms).length * HIT_CH + 12)
  }
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
  const at = focusState ?? cursorState ?? fst.root
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
      <svg width={svgWidth} height={height} className="cu-fst-svg">
        {fst.states.flatMap((s) =>
          s.arcs.map((a) => {
            const p1 = pos.get(s.id)
            const p2 = pos.get(a.to)
            if (!p1 || !p2) return null
            const key = `${s.id}:${a.label}`
            const cls = followed?.has(key)
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
          const hit = matches?.get(s.id)
          return (
            <g
              key={s.id}
              className={
                'cu-state' +
                (s.id === cursorState ? ' cursor' : '') +
                (dimmed?.has(s.id) ? ' dim' : '') +
                (hit ? ' matched' : '') +
                (hasOut ? ' has-out' : '')
              }
            >
              {hit && <circle cx={p.x} cy={p.y} r={23} className="cu-state-halo" />}
              <circle cx={p.x} cy={p.y} r={17} />
              {hasOut && (
                <text x={p.x} y={p.y + 4} className="cu-state-out">
                  {hex(s.out)}
                </text>
              )}
              {/* The terms the block behind this address turned out to hold —
                  set BESIDE the bubble, never inside it, so it reads as "what
                  was found here" rather than as the node's name. */}
              {hit && (
                <text x={p.x + HIT_GAP} y={p.y + 4} className="cu-state-hit">
                  {hitLabel(hit)}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <div className="cu-fst-legend">
        <span className="cu-fst-key">
          an arrow <b>consumes one character</b> · a circle is <b>a node</b>, and an
          address inside one means <b>“a block lives here”</b> · a node <b>indexes its
          own arrows</b>, so a walk that knows the character it wants jumps straight
          to one and compares none of the rest
        </span>
        <span><i className="dot has-out" /> carries a .tim block pointer</span>
        <span><i className="dot followed" /> the arrows this query took · grey was never looked at</span>
        {pruned?.size > 0 && (
          <span><i className="dot pruned" /> no live transition accepts it — everything behind it is skipped unread</span>
        )}
        {matches?.size > 0 && (
          <span>
            <i className="dot matched" /> its block held a match — the word beside it is what was found
          </span>
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
        {/* Precisely: (i,e) accepts when the query's remaining characters could
            all be deleted inside the remaining budget, n - i <= maxEdits - e.
            So it means "if the term ENDED here it would already be a match" —
            not "the query is reachable from here", which is a weaker claim. */}
        <span>
          <i className="dot accept" /> accepting: a term ending here is already within{' '}
          {grid.maxEdits} edit{grid.maxEdits === 1 ? '' : 's'} of “{pattern?.literal}”
        </span>
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
