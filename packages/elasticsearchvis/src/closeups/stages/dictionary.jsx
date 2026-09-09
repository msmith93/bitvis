import { useEffect, useRef } from 'react'
import { buildTermIndex, seekTrace } from '../../blocktree'
import {
  compileAutomaton,
  explainDecision,
  gridEdgesCarrying,
  intersectTrace,
} from '../../automaton'
import { parsePattern, patternLabel } from '../../wildcard'
import { AUTOMATON_STEP_MS, BLOCK_READ_MS } from '../../timing'
import {
  ArcGraph,
  AutomatonGrid,
  BlockColumn,
  hexAddr,
  scrollTileTo,
  useReveal,
} from '../shared'

// The term-dictionary half of the segment close-up: how the index finds what a
// query is asking for without holding the term dictionary in memory.
//
// This module is no longer a stage of its own. `stages/segment.jsx` owns the
// panel — four tiles (term index, term blocks, postings, stored fields) and a
// camera that dives into one at a time — and this file supplies the first two
// tiles: `deriveDictionary` runs the models once per build, `FstTile` draws the
// in-memory side (the .tip FST, the compiled query beside it in fuzzy mode, and
// the walk readout) and `BlocksTile` the on-disk .tim strip with its scan. The
// two used to sit on one scroller as ONE PICTURE; that rule now holds within a
// tile — a tile's content never swaps per step, a step only changes what is lit
// on it and which tile the camera is on — and SPEC.md records the change.
//
// The SAME picture serves every kind of query, because a plain term is just the
// degenerate case of a pattern — an automaton with exactly one acceptable
// reading. Every mode drives ONE replay with one set of rules: green is an arc
// the walk followed, red is one it refused on sight (with everything behind it
// dimmed and skipped unread), and the cursor pans to the decision being made.
//
//   term mode     the term's own automaton follows one path; one block is read.
//                 The COST numbers come from seekTrace, not the intersection —
//                 see the note in deriveDictionary().
//   pattern mode  the pattern's automaton follows some arcs and prunes others;
//                 the surviving blocks are read.
//   fuzzy mode    the same walk, but the automaton is DRAWN beside the FST and
//                 the two move in lockstep.
//
// Why fuzzy gets the extra panel, when a wildcard does not: for a glob the
// interesting question is which arcs survived, and the FST alone answers it. For
// an edit-distance machine the interesting question is which (characters
// matched, edits spent) states are still alive — a SET, changing every
// character, that nothing in the FST can show you. So in fuzzy mode the tile
// holds the two things that are actually in memory: the term index and the
// compiled query. The RAM/disk distinction is still drawn, still labelled.
//
// Term mode and pattern mode were once two separate close-ups. They drew the
// same two structures twice, so they were merged; see SPEC.md. Term mode later
// had its own visual language too (green node fills, a dashed dead-end stub);
// that was folded into the one arc replay for the same reason.

// The per-mode copy for the dictionary steps. segment.jsx owns the step list
// (overview · walk · read · found · postings · done) and looks these up by key.
const TERM_BLURBS = {
  walk:
    'One exact term is the simplest machine there is: at every node, precisely one arrow can still spell it. Watch that arrow light green and every sibling die red on sight — nothing behind a red arrow is ever looked at. Whenever the walk lands on a node carrying an address, it remembers it: the last block that could still contain the term. All of this happens in memory.',
  read:
    'The arrows ran out, so the address the walk was carrying is the answer: the only block that can hold this term. It is read, and its rows are scanned in order. Every other block below is untouched.',
  found:
    'The row gives the term, how many documents contain it, and where its posting list starts in .doc — the address the next tile is opened at. Note what never happened: the dictionary itself was never loaded. The index that found the row is the small graph in memory, and it never left it.',
}

const PATTERN_BLURBS = {
  walk:
    'A pattern can match many terms, so instead of spelling one out, the query is turned into a little machine that says which characters are still acceptable. Watch it decide, arrow by arrow: green is an arrow it accepted, red is one it refused on sight — and everything behind a red arrow is skipped without ever being looked at.',
  read:
    'Only the blocks the walk actually reached are read. Everything greyed out below was eliminated by the walk above — not by a shortcut or a guess, but because the pattern provably cannot match anything inside it.',
  found:
    'The terms that survived are the expansion: from here the wildcard is an ordinary OR over them — one posting list per term, read next. And the cost was decided entirely by where the pattern let the walk go.',
}

const FUZZY_BLURBS = {
  index:
    'Two structures, and only one of them is on disk. The term index on the left is the same one every query uses. The machine on the right is this query — “within N edits of a word” compiled into states you can point at.',
  walk:
    'Now watch them move together. One arrow of the index is one character of a candidate term, and the automaton consumes that same character at the same moment. Going RIGHT in the grid means the character was the one expected; going DOWN means an edit was spent to accept it. The walk is in several states at once — it has to be, because it does not yet know which reading of the term will turn out to be the cheap one. When no state survives a character, the arrow dies and every term behind it is skipped unread.',
  read:
    'Only the blocks the walk actually reached are read. Everything greyed out was eliminated by the automaton above — because there is no continuation of that prefix the machine could still accept within its edit budget.',
  found:
    'One thing the walk above could not show you: it only ever consumed BLOCK PREFIXES, a character or three, so it never reached the right-hand edge of the grid. The word gets finished here, when the block is read — watch the machine spell out the rest of the term it matched and land on an accepting state. That is where the verdict actually comes from. And note what it compared to get there: spelling. It has no idea what any of these words mean.',
}

export const DICT_BLURBS = { term: TERM_BLURBS, pattern: PATTERN_BLURBS, fuzzy: FUZZY_BLURBS }

// Everything the two dictionary tiles draw, derived once per build. Pure apart
// from the models it calls; segment.jsx hands the result to the tiles as props.
export function deriveDictionary({ shard, segId, rows, term, patterns }) {
  const index = buildTermIndex(rows)
  const pattern = patterns?.find((p) => p.kind !== 'term') ?? null
  const mode = pattern ? (pattern.kind === 'fuzzy' ? 'fuzzy' : 'pattern') : 'term'

  // ONE walk model for every mode: even a plain term compiles to an automaton
  // (the degenerate one with a single acceptable reading) and intersects with
  // the FST, so the replay obeys the same rules whatever the query. Compiled
  // against `term` — the pickTerm result the seek below uses — so the walk and
  // the seek are the same word.
  const alphabet = [...new Set(index.terms.flatMap((t) => [...t]))]
  const dfa = compileAutomaton(pattern ?? parsePattern(term), alphabet)
  // CAUTION: in term mode `hits` drives the PICTURE only, never the cost copy.
  // TermsEnum.intersect loads a block at every output-carrying state along the
  // descent (three for `search` here), where seekExact carries the last output
  // and reads exactly ONE — which is the number this zoom exists to teach. Term
  // mode's block/read/found story therefore stays on `trace` (seekTrace).
  const hits = intersectTrace(index, dfa)
  const trace =
    mode === 'term'
      ? { ...seekTrace(index, term), shardId: shard.id, segId }
      : null

  // The arc walk consumes BLOCK PREFIXES — a character or three — so it can never
  // reach an accepting state on its own; on this data `serch~` never gets past
  // "3 characters matched" of 5. The word is finished later, when a block is
  // read and its terms are tested one by one, and THAT is where the machine
  // lands on the right-hand column and accepts. The found step replays it for
  // the term that matched, because otherwise the grid looks stuck partway across
  // and the reader is left wondering how it ever decided anything.
  const matched = pattern ? hits.visits.find((v) => v.action === 'accept') ?? null : null

  // Which visits the walk step replays: every arc DECISION, followed or pruned.
  // A glob used to draw only its follows, on the theory that animating skipped
  // work was the opposite of the lesson. That was backwards — for `sc*` the
  // whole lesson IS that every arc but 's' dies at the root, and leaving those
  // undrawn made the cheapest pattern look identical to the most expensive one.
  // One replay, one set of rules, whatever the query.
  const walkVisits = hits.visits.filter((v) => v.action === 'follow' || v.action === 'prune')

  // What the read step opens and replays, per mode — see buildReads.
  const reads = buildReads(index, mode, trace, hits)

  // The terms this segment resolved the query to: what the postings tile walks.
  const matchedTerms =
    mode === 'term' ? (trace.found ? [trace.meta.term] : []) : [...hits.matched].sort()

  return {
    index,
    mode,
    pattern,
    term,
    dfa,
    hits,
    trace,
    matched,
    walkVisits,
    units: Math.max(1, walkVisits.length),
    tick: AUTOMATON_STEP_MS,
    reads,
    matchedTerms,
    blurbs: DICT_BLURBS[mode],
    looking: mode === 'term' ? `“${term}”` : `“${pattern.raw}”`,
  }
}

// What is happening RIGHT NOW, for a guided step that walks the reader through
// the intersection. Fuzzy only: it is the automaton beside the index that makes
// "why did it go that way" answerable at all. `at` maps step keys to indices.
export function narrateDictionary(d, at, i, subAt) {
  if (d.mode !== 'fuzzy') return null
  const { dfa, walkVisits, reads, hits, matched } = d
  if (i === at.walk) {
    const n = subAt ?? walkVisits.length
    return n <= 0
      ? sayStart(dfa)
      : sayDecision(dfa, walkVisits[n - 1], walkVisits[n - 2] ?? null)
  }
  if (i === at.read) {
    const n = subAt ?? reads.order.length
    const row = reads.order[Math.max(0, n - 1)]
    if (!row) return null
    return {
      kind: row.hit ? 'accept' : 'follow',
      text:
        (n <= 1
          ? `Only the ${hits.blocksLoaded} of ${hits.blocksTotal} blocks the walk ` +
            `reached come off the disk; the rest died with the arrows above. Their ` +
            `terms are now tested one at a time. `
          : '') +
        `${q(row.term)} — ` +
        `${row.hit ? 'within one edit of the query, so it matches' : 'more than one edit away, so it does not'}.`,
    }
  }
  if (i === at.found && matched) {
    const steps = matched.path.steps
    const n = Math.max(1, Math.min(subAt ?? steps.length, steps.length))
    const st = steps[n - 1]
    const done = n >= steps.length
    const x = explainDecision(dfa, { dfaFrom: st.from, dfaTo: st.to, label: st.ch })
    return {
      kind: done ? (matched.path.accepts ? 'accept' : 'prune') : 'follow',
      text:
        (n <= 1
          ? `The arc walk only ate block prefixes — ${q(matched.path.prefix)} — so the ` +
            `word is finished here, against the block that was read. `
          : '') +
        `Feeding ${q(st.ch)} of ${q(matched.term)}: ` +
        // sayWhy opens a sentence; here it continues one.
        (x ? sayWhy(x).charAt(0).toLowerCase() + sayWhy(x).slice(1) : '') +
        (done
          ? matched.path.accepts
            ? ` That is the last character, and the machine lands on an ACCEPTING state — ` +
              `${q(matched.term)} is within one edit of the query. This is the only view ` +
              `that ever reaches the right-hand column.`
            : ` That is the last character, and no accepting state was reached.`
          : ` ${matched.path.rest.length - n} to go.`),
    }
  }
  return null
}

// The read step, folded into one shape for every mode: which blocks open in
// place (`expandedFps`), the scan each one replays (`scans`, fp → {rows} in
// blockScan shape), and the total row count (`rowUnits`) the reveal counter and
// the step's dwell share. Rows carry a GLOBAL `order` so several blocks replay
// in sequence rather than in parallel.
//
// Which blocks open: the ones whose read produced a match — that is the payoff
// being taught — and when nothing matched, the last block read, so the step
// still shows rows being compared and failing.
function buildReads(index, mode, trace, hits) {
  if (mode === 'term') {
    if (!trace.block || !trace.inBlock)
      return { expandedFps: new Set(), scans: new Map(), rowUnits: 0, order: [] }
    return {
      expandedFps: new Set([trace.block.fp]),
      scans: new Map([[trace.block.fp, trace.inBlock]]),
      rowUnits: trace.inBlock.rows.length,
      order: trace.inBlock.rows.map((r) => ({
        fp: trace.block.fp,
        term: r.entry?.term ?? null,
        hit: !!r.hit,
        stop: !!r.stop,
      })),
    }
  }

  // Pattern/fuzzy: fold the accept/reject visits into per-block scans, in the
  // order the walk actually tested them.
  const byFp = new Map()
  for (const v of hits.visits) {
    if (v.action !== 'accept' && v.action !== 'reject') continue
    if (!byFp.has(v.fp)) byFp.set(v.fp, [])
    byFp.get(v.fp).push(v)
  }
  let open = [...byFp.keys()].filter((fp) => byFp.get(fp).some((v) => v.action === 'accept'))
  if (!open.length && byFp.size) open = [[...byFp.keys()].pop()]

  const scans = new Map()
  const order = []
  for (const fp of open) {
    const block = index.byFp[fp]
    if (!block) continue
    const rows = []
    for (const v of byFp.get(fp)) {
      const i = block.entries.findIndex((e) => e.kind === 'term' && e.term === v.term)
      if (i < 0) continue
      rows.push({ i, hit: v.action === 'accept', stop: false, order: order.length })
      order.push({ fp, term: v.term, hit: v.action === 'accept', visit: v })
    }
    scans.set(fp, { rows })
  }
  return { expandedFps: new Set(scans.keys()), scans, rowUnits: order.length, order }
}

// ---------------------------------------------------------------------------
// Saying WHY, one decision at a time
// ---------------------------------------------------------------------------

// The guided walk needs to explain each step as the reader takes it, not just
// animate it. Everything below is folded out of the trace and the compiled
// machine (via explainDecision) — no sentence asserts anything the model did not
// actually do, which is the same rule the rendered numbers follow.
const q = (c) => `“${c}”`
const list = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`)
const readings = (nodes) =>
  list(nodes.filter((n) => !n.bridge).map((n) => `(${n.i},${n.e})`))

// Why a character got through: which readings were waiting for it (free), and
// which had to spend an edit to take it. Shared by the arc walk and the in-block
// spell-out, because it is the same question either way.
function sayWhy(x) {
  const one = x.matched.length === 1
  if (x.matched.length && x.payers.length)
    return (
      `${readings(x.matched)} ${one ? 'was' : 'were'} waiting for exactly this character, so ` +
      `${one ? 'it advances' : 'they advance'} a column and ${one ? 'pays' : 'pay'} nothing; ` +
      `${readings(x.payers)} can also spend an edit to take it another way.`
    )
  if (x.matched.length)
    return (
      `${readings(x.matched)} ${one ? 'was' : 'were'} waiting for exactly this character, so ` +
      `${one ? 'it advances' : 'they advance'} a column and ${one ? 'pays' : 'pay'} nothing.`
    )
  if (x.payers.length)
    return (
      `Nothing was expecting it` +
      `${x.expecting.length ? ` (they want ${list(x.expecting.map(q))})` : ''}, but ` +
      `${readings(x.payers)} still ${x.payers.length === 1 ? 'has' : 'have'} an edit in hand — ` +
      `spending it buys the character as a substitution or an extra letter, which is the drop ` +
      `to the row below.`
    )
  return `No reading could take it.`
}

// One arc decision: which character the index offered, which readings could take
// it and at what price, or why every one of them died.
function sayDecision(dfa, visit, prev) {
  const x = explainDecision(dfa, visit)
  if (!x) return null
  const where = visit.prefix ? `out of ${q(visit.prefix)}` : 'out of the root'

  // The intersection is DEPTH-FIRST, so it backtracks: once a subtree is
  // exhausted the next arc is tried from an ancestor, and the live set jumps
  // back to what it was there. Unsaid, that looks like the machine losing
  // progress — it is the single most confusing thing about watching the walk.
  let lead = ''
  if (prev) {
    const wasAt = prev.action === 'follow' ? prev.prefix + prev.label : prev.prefix
    if (wasAt !== visit.prefix)
      lead =
        `Everything under ${q(wasAt)} is finished, so the walk backs up to ` +
        `${visit.prefix ? q(visit.prefix) : 'the root'} and picks the machine back up in the ` +
        `state it had there. `
  }

  const head = `${lead}The index offers ${q(x.label)} ${where}.`

  if (visit.action === 'prune') {
    return {
      kind: 'prune',
      text:
        `${head} Every reading still alive — ${readings(x.from)} — has already spent its ` +
        `one edit, so nothing can be bought any more: only the exact character each one ` +
        `is waiting for (${list(x.expecting.map(q))}) would keep it going. ` +
        `${q(x.label)} is none of those, so the set empties and the arrow is refused. ` +
        `The ${visit.termsSkipped} term${visit.termsSkipped === 1 ? '' : 's'} behind it are ` +
        `never read — not skipped as a guess, but because no continuation of ` +
        `${q(visit.prefix + x.label)} could be within one edit of the query.`,
    }
  }

  const parts = [sayWhy(x)]
  const alive = x.to.filter((n) => !n.bridge).length
  const tail =
    alive === 1
      ? `The walk follows the arrow, and exactly one reading comes through.`
      : `The walk follows the arrow, and the machine is now in ${alive} readings at once — ` +
        `it cannot yet tell which will pay off, so it keeps them all.`

  return {
    kind: x.accepting ? 'accept' : 'follow',
    text:
      `${head} ${parts.join(' ')} ${tail}` +
      (x.accepting
        ? ` One of them already accepts: a term stopping here would be within budget.`
        : ''),
  }
}

// Step 2 before the first press: what the machine is, before it has seen
// anything. This is where the "no arc out of the root can be refused" lesson
// lives, and it is a consequence of the start set rather than an assertion.
function sayStart(dfa) {
  const grid = dfa.grid
  const byId = new Map(grid.nodes.map((n) => [n.id, n]))
  const start = (dfa.states[dfa.start]?.nfaSet ?? []).map((x) => byId.get(x)).filter(Boolean)
  const budget = start.some((n) => !n.bridge && n.e < grid.maxEdits)
  return {
    kind: 'start',
    text:
      `Nothing consumed yet. The machine starts in ${readings(start)}: the empty prefix with ` +
      `the edit unspent, and the reading that has already thrown away the first letter of ` +
      `${q(grid.term)}. ` +
      (budget
        ? `Because an edit is still in hand, ANY first character can be bought — which is why ` +
          `no arrow out of the root can be refused, and why a fuzzy query still reads a good ` +
          `part of the dictionary before the pruning can start.`
        : ''),
  }
}

// The in-memory tile: the .tip FST (and, for a fuzzy, the compiled query beside
// it) with the walk readout beneath. `live` is true only while the camera has
// landed on this tile and the panel is the active close-up — a replay that ran
// while the tile was still springing in would be half over before it could be
// seen. `sub` is the mini-stepper's manual position: when it is non-null the
// user is scrubbing, each reveal's `on` goes false and it parks at the end
// (useReveal's off-semantics) while the view reads `sub` instead.
export function FstTile({ d, step, sub, live, at }) {
  const { index, mode, trace, hits, dfa, pattern, term, tick, walkVisits, matched } = d
  const total = walkVisits.length
  const walked = useReveal(step === at.walk && live && sub == null, total, tick)
  // The found step, fuzzy: the machine finishing the word it matched, one
  // character at a time, until it lands on an accepting state.
  const spelledClock = useReveal(
    step === at.found && live && mode === 'fuzzy' && !!matched && sub == null,
    matched?.path.steps.length ?? 0,
    tick,
  )

  const walking = step >= at.walk
  const reading = step >= at.read
  const shown = step === at.walk ? (sub ?? walked) : Infinity
  const spelled = sub ?? spelledClock // only read on the found step

  // What the picture highlights: ONE replay for every mode. The walk lights the
  // arcs it took, reddens the ones it refused, dims what a refusal skipped, and
  // pans to the decision being made — a plain term differs only in having a
  // one-reading automaton, so exactly one path survives.
  const revealed = walkVisits.slice(0, shown)
  const followed = new Set()
  const pruned = new Set()
  for (const v of revealed) {
    const key = `${v.fstFrom}:${v.label}`
    if (v.action === 'follow') followed.add(key)
    else pruned.add(key)
  }
  const last = revealed[revealed.length - 1] ?? null

  // Which nodes get the "its block held a match" halo — only once the blocks
  // have been read; before that the walk genuinely does not know. Term mode
  // reads this off the SEEK (one block, one term), never off the intersection,
  // which touches more blocks than a real seekExact would.
  let matches = null
  if (reading) {
    if (mode === 'term') {
      matches =
        trace.found && trace.block
          ? matchNodesOf(index, new Map([[trace.block.fp, [trace.meta.term]]]))
          : new Map()
    } else {
      const byFp = new Map()
      for (const v of hits.visits) {
        if (v.action !== 'accept') continue
        if (!byFp.has(v.fp)) byFp.set(v.fp, [])
        byFp.get(v.fp).push(v.term)
      }
      matches = matchNodesOf(index, byFp)
    }
  }

  const arcProps = walking
    ? {
        followed,
        pruned,
        dimmed: subtreeOf(index.fst, revealed.filter((v) => v.action === 'prune')),
        // The ring marks where the walk IS; the pan follows what the step is
        // ABOUT. For a prune those are different nodes, and the far end is the
        // one worth looking at.
        cursor: last ? (last.action === 'follow' ? last.fstTo : last.fstFrom) : index.fst.root,
        focus: last ? last.fstTo : index.fst.root,
        matches,
      }
    : { matches }

  // The automaton panel's lit set, per step: the walk's own cursor while
  // walking; on the read step the union of states that made a block worth
  // reading (NOT the walk's last leftover cursor — that lit a meaningless
  // near-start set for the whole step); and on the found step the machine
  // finishing the matched word, the only view that reaches the accepting
  // column.
  let lev = null
  if (mode === 'fuzzy' && walking) {
    if (step === at.walk) lev = levView(dfa, revealed)
    else if (matched && step >= at.found) lev = levTermView(dfa, matched, spelled)
    else lev = levBlockView(dfa, hits)
  }

  return (
    <>
      <div className={'cu-split' + (mode === 'fuzzy' ? ' fuzzy' : '')}>
        <section className="cu-side ram" data-tour="fst">
          <header className="cu-side-head">
            <span className="cu-side-title">in memory · .tip</span>
            <span className="cu-side-sub">the term index</span>
          </header>

          <ArcGraph fst={index.fst} index={index} {...arcProps} />

          <footer className="cu-side-foot">
            <b>{index.fst.fstStates}</b> states ·{' '}
            <b>{index.fst.states.reduce((n, s) => n + s.arcs.length, 0)}</b> arcs
            <i>never leaves memory</i>
          </footer>
        </section>
        {mode === 'fuzzy' && (
          <section className="cu-side ram" data-tour="automaton">
            <header className="cu-side-head">
              <span className="cu-side-title">in memory · the query</span>
              <span className="cu-side-sub">{patternLabel(pattern)}</span>
            </header>
            <AutomatonGrid
              grid={dfa.grid}
              pattern={pattern}
              live={lev?.live}
              entered={lev?.entered}
              taken={lev?.taken}
              dead={!!lev?.dead}
            />
            <footer className="cu-side-foot">
              <b>{dfa.states.length}</b> states after determinizing
              <i>never leaves memory</i>
            </footer>
          </section>
        )}
      </div>

      <WalkReadout
        mode={mode}
        lev={lev}
        pattern={pattern}
        dfa={dfa}
        walking={walking}
        done={step > at.walk}
        hits={hits}
        trace={trace}
        term={term}
        index={index}
        visits={revealed}
      />
    </>
  )
}

// The on-disk tile: every .tim block as a strip, the one(s) the walk reached
// opened in place on the read step with their rows replayed in scan order, and
// the walk's totals beneath. `postings` (src/postings.js) lets an opened row
// name the real .doc address its term points at — the hop the next tile opens.
export function BlocksTile({ d, step, sub, live, at, postings }) {
  const { index, mode, trace, hits, dfa, pattern, term, reads } = d
  const rows = useReveal(step === at.read && live && sub == null, reads.rowUnits, BLOCK_READ_MS)
  const reading = step >= at.read
  const rowsShown = step === at.read ? (sub ?? rows) : Infinity

  // Bring the opened block into view once the tile has landed: the strip can be
  // longer than the tile, and the read step's lesson is which block left the
  // disk. Instant, and only on a step change, so it never fights the reader.
  const ref = useRef(null)
  useEffect(() => {
    if (!live || !reading) return
    return scrollTileTo(ref.current, '.cu-bcol-item.expanded')
  }, [step, live, reading])

  const focusFp = mode === 'term' ? trace.block?.fp ?? null : null
  const loadedFps =
    mode !== 'term' && reading
      ? new Set(hits.visits.filter((v) => v.action === 'load').map((v) => v.fp))
      : null

  return (
    <>
      <section className="cu-side disk cu-disk-strip" ref={ref}>
        <header className="cu-side-head">
          <span className="cu-side-title">on disk · .tim</span>
          <span className="cu-side-sub">
            {index.blocks.length} blocks
            {reading && <> · {mode === 'term' ? trace.blocksRead : hits.blocksLoaded} read</>}
          </span>
        </header>

        <BlockColumn
          index={index}
          focusFp={focusFp}
          expandedFps={reading ? reads.expandedFps : null}
          loadedFps={loadedFps}
          scans={reads.scans}
          revealed={rowsShown}
          postings={postings}
        />
      </section>

      {reading && (
        <WalkReadout
          mode={mode}
          lev={null}
          pattern={pattern}
          dfa={dfa}
          walking
          done
          hits={hits}
          trace={trace}
          term={term}
          index={index}
          visits={[]}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// The two cursors, folded out of the trace
// ---------------------------------------------------------------------------

// Which FST states point at a block where a term actually matched, and which
// terms those were.
//
// This is deliberately NOT "the node is the term". A state's bubble holds a .tim
// ADDRESS: 34 states index 89 terms here, one leaf points at a block of seven,
// and minimization merges states that two different prefixes reach — so a node
// can never be labelled with a word without lying about the structure. What it
// CAN honestly say is "the walk that came through here ended up paying off, and
// this is what it found", which is the thing the picture was missing.
function matchNodesOf(index, byFp) {
  const out = new Map()
  if (!byFp.size) return out
  for (const st of index.fst.states) {
    if (st.out == null) continue
    const block = index.byFp[st.out]
    // A floor-split block is pointed at by its parent's address, so the terms
    // may live under any of its floors.
    const fps = [st.out, ...(block?.floors?.map((f) => f.fp) ?? [])]
    const terms = [...new Set(fps.flatMap((fp) => byFp.get(fp) ?? []))]
    if (terms.length) out.set(st.id, terms)
  }
  return out
}

// The block address a term walk is holding after consuming `prefix`: the
// deepest output on that path, with the root block as the fallback — the same
// "remember the last address you passed" rule fstSeek applies. The readout
// re-derives it from the prefix because the intersection walk backtracks, so
// the carried address is a property of the CURRENT candidate path, not of the
// visit list.
function carriedAlong(index, prefix) {
  const { states, root } = index.fst
  let s = root
  let out = states[root].out
  for (const ch of prefix) {
    const arc = states[s].arcs.find((a) => a.label === ch)
    if (!arc) break
    s = arc.to
    if (states[s].out != null) out = states[s].out
  }
  return out
}

// Which FST states sit behind an arc that was pruned — the terms nobody read.
function subtreeOf(fst, prunes) {
  const out = new Set()
  const stack = prunes.map((v) => v.fstTo)
  while (stack.length) {
    const id = stack.pop()
    if (id == null || out.has(id)) continue
    out.add(id)
    for (const a of fst.states[id].arcs) stack.push(a.to)
  }
  return out
}

// The lowest edit layer any live state sits on — "the cheapest reading of this
// prefix so far". Bridges are mid-layer bookkeeping, so they don't count.
function bestEdits(grid, ids) {
  let best = Infinity
  for (const id of ids) {
    const n = grid.nodes.find((x) => x.id === id)
    if (n && !n.bridge) best = Math.min(best, n.e)
  }
  return best
}

// Everything the automaton panel and the readout need for the CURRENT position
// of the walk: which states are alive, which just arrived, which grid edges got
// used to arrive, and what that cost.
function levView(dfa, revealed) {
  const grid = dfa.grid
  const last = revealed[revealed.length - 1] ?? null

  const setOf = (id) => new Set(id == null ? [] : dfa.states[id].nfaSet)

  // WHERE THIS VISIT CAME FROM IS `dfaFrom`, NOT THE PREVIOUS VISIT'S `dfaTo`.
  // The intersection is depth-first and backtracks: once a subtree is finished
  // the next arc is tried from an ANCESTOR, so the visit before this one in the
  // list is usually not the state this one started in. Reading the previous
  // visit's destination made the from-set wrong after every backtrack, which is
  // most of the walk — and since the highlight is the intersection of that set
  // with this one, almost no edge ever lit up.
  const live = last == null ? new Set(dfa.states[dfa.start].nfaSet) : setOf(last.dfaTo)
  const prevLive = last == null ? new Set() : setOf(last.dfaFrom)
  const entered = new Set([...live].filter((id) => !prevLive.has(id)))
  const char = last?.label ?? null

  // Which drawn edges could have carried the walk from prevLive into live —
  // the model's own answer (gridEdgesCarrying), shared with levTermView.
  const taken = char != null ? gridEdgesCarrying(grid, prevLive, live, char) : new Set()

  const bestNow = bestEdits(grid, live)
  const bestBefore = last == null ? 0 : bestEdits(grid, prevLive)
  // (both read the same from/to pair as `taken` above, so the verdict, the
  // pulse and the lit edge can never disagree about what just happened)
  const dead = live.size === 0

  return {
    grid,
    live,
    entered,
    taken,
    dead,
    visit: last,
    prefix: last == null ? '' : last.action === 'follow' ? last.prefix + last.label : last.prefix,
    char,
    fstNode: last == null ? null : last.action === 'follow' ? last.fstTo : last.fstFrom,
    edits: Number.isFinite(bestNow) ? bestNow : null,
    spentAnEdit: !dead && last != null && bestNow > bestBefore,
    // A live accepting state means the candidate prefix is ALREADY within budget
    // — the walk has found a match and is still going, looking for longer ones.
    accepting: [...live].some((id) => grid.nodes.find((n) => n.id === id)?.accept),
    pruned: last?.action === 'prune' ? last : null,
  }
}

// The machine finishing ONE word, `shown` characters in. This is the only view
// that ever reaches the right-hand column of the grid: the arc walk stops when
// the block prefixes run out, and everything after that is the in-block scan.
function levTermView(dfa, visit, shown) {
  const grid = dfa.grid
  const setOf = (id) => (id == null ? new Set() : new Set(dfa.states[id].nfaSet))
  const steps = visit.path.steps.slice(0, Math.max(1, shown))
  const taken = new Set()
  let prev = setOf(steps[0]?.from ?? dfa.start)
  for (const st of steps) {
    const to = setOf(st.to)
    for (const key of gridEdgesCarrying(grid, prev, to, st.ch)) taken.add(key)
    prev = to
  }
  const last = steps[steps.length - 1]
  const live = setOf(last?.to ?? steps[0]?.from ?? dfa.start)
  return {
    grid,
    live,
    entered: live,
    taken,
    dead: live.size === 0,
    spelling: {
      term: visit.term,
      prefix: visit.path.prefix,
      done: steps.map((x) => x.ch).join(''),
      rest: visit.path.rest.slice(steps.length),
      accepts: visit.path.accepts,
      complete: shown >= visit.path.steps.length,
    },
    accepting: [...live].some((id) => grid.nodes.find((n) => n.id === id)?.accept),
  }
}

// The read step's resting view of the grid: the union of the state sets that
// made a block worth reading. The walk is over — its last cursor is a leftover
// from wherever the depth-first search happened to finish, and lighting THAT
// for the whole step (as this stage once did) said nothing. "These are the
// states that earned these disk reads" is derived, honest, and explains the
// step it sits beside.
function levBlockView(dfa, hits) {
  const grid = dfa.grid
  const live = new Set()
  for (const v of hits.visits) {
    if (v.action !== 'load') continue
    for (const id of dfa.states[v.dfaFrom].nfaSet) live.add(id)
  }
  return {
    grid,
    live,
    entered: new Set(),
    taken: new Set(),
    dead: false,
    accepting: [...live].some((id) => grid.nodes.find((n) => n.id === id)?.accept),
  }
}

// The transcript's third panel, as a strip: where the walk's cursor is, what
// the query is currently able to accept, and the verdict on the character just
// consumed — for EVERY mode, because neither structure above can say it alone.
// A fuzzy carries its live state set here; a glob carries what it accepts; a
// term carries the block address the walk is holding. Once the walk is over it
// totals up instead (term totals come from the seek — see build()).
function WalkReadout({ mode, lev, pattern, dfa, walking, done, hits, trace, term, index, visits }) {
  // Fuzzy, found step: the machine finishing a word, rather than a cursor
  // mid-walk.
  if (lev?.spelling) {
    const sp = lev.spelling
    return (
      <div className={'cu-isect ' + (sp.complete && sp.accepts ? 'exact' : 'edit')}>
        <div className="cu-isect-cell">
          <span className="cu-isect-k">finishing the word</span>
          <b className="cu-isect-prefix">
            {sp.prefix ? <i className="cu-isect-was">{sp.prefix}</i> : null}
            {sp.done}
            {sp.rest ? <i className="cu-isect-todo">{sp.rest}</i> : null}
          </b>
        </div>
        <div className="cu-isect-cell grow">
          <span className="cu-isect-k">
            where the machine is now · {lev.live.size || 'no'} state
            {lev.live.size === 1 ? '' : 's'}
          </span>
          <span className="cu-isect-states">
            {[...lev.live]
              .map((id) => lev.grid.nodes.find((n) => n.id === id))
              .filter((n) => n && !n.bridge)
              .sort((a, b) => a.e - b.e || a.i - b.i)
              .map((n) => (
                <i key={n.id} className={'cu-isect-state' + (n.accept ? ' accept' : '')}>
                  {n.i},{n.e}
                </i>
              ))}
          </span>
        </div>
        <div className={'cu-isect-verdict ' + (sp.complete && sp.accepts ? 'exact' : 'edit')}>
          {sp.complete ? (sp.accepts ? 'accepted' : 'rejected') : 'reading…'}
          <i>
            {sp.complete
              ? 'the arc walk never got this far right — the block scan did'
              : `${sp.rest.length} character${sp.rest.length === 1 ? '' : 's'} to go`}
          </i>
        </div>
      </div>
    )
  }

  if (!walking) return null

  // Once the walk is over there is no cursor to report, and leaving the last
  // verdict standing reads as a failure notice above a perfectly good result.
  // The strip stays (so the layout doesn't jump) and totals up instead. The
  // cost cells are the one place the modes must part ways: a term's numbers
  // come from the SEEK (one block read), never from the intersection.
  if (done) {
    const matchedTerms = mode === 'term' ? (trace.found ? [trace.meta.term] : []) : hits.matched
    const matchedLabel =
      mode === 'fuzzy'
        ? `terms within ${pattern.maxEdits} edit${pattern.maxEdits === 1 ? '' : 's'}`
        : mode === 'pattern'
          ? `terms matching “${pattern.raw}”`
          : 'the term'
    return (
      <div className="cu-isect done">
        <div className="cu-isect-cell">
          <span className="cu-isect-k">walk</span>
          <b>complete</b>
        </div>
        <div className="cu-isect-cell">
          <span className="cu-isect-k">arcs pruned</span>
          <b>{hits.prunedArcs}</b>
        </div>
        <div className="cu-isect-cell grow">
          <span className="cu-isect-k">{matchedLabel}</span>
          <span className="cu-isect-states">
            {matchedTerms.length ? (
              matchedTerms.map((t) => (
                <i key={t} className="cu-isect-state accept">
                  {t}
                </i>
              ))
            ) : (
              <i className="cu-isect-state none">none</i>
            )}
          </span>
        </div>
        {mode === 'term' ? (
          <div className="cu-isect-verdict done">
            {trace.blocksRead} of {index.blocks.length} block
            {index.blocks.length === 1 ? '' : 's'} read
            <i>
              {trace.outOfRange
                ? 'out of this segment’s term range — zero disk reads'
                : `${trace.entriesRead} row${trace.entriesRead === 1 ? '' : 's'} compared inside it`}
            </i>
          </div>
        ) : (
          <div className="cu-isect-verdict done">
            {hits.termsRead} of {hits.termsTotal} terms read
            <i>{hits.blocksLoaded} of {hits.blocksTotal} blocks left the disk</i>
          </div>
        )}
      </div>
    )
  }

  // Mid-walk, term and pattern: the same strip a fuzzy gets, with the grow cell
  // carrying what THIS query knows mid-walk — the block address a term walk is
  // holding, or what a glob accepts.
  if (mode !== 'fuzzy') {
    const last = visits[visits.length - 1] ?? null
    const prefix = last == null ? '' : last.action === 'follow' ? last.prefix + last.label : last.prefix
    const prune = last?.action === 'prune' ? last : null
    const verdict = prune
      ? { cls: 'dead', text: 'refused on sight — PRUNE' }
      : {
          cls: 'exact',
          text:
            last == null
              ? 'start'
              : mode === 'term'
                ? 'this arrow can still spell the term'
                : 'the pattern accepts it',
        }
    const carried = mode === 'term' ? carriedAlong(index, prefix) : null
    return (
      <div className={'cu-isect ' + verdict.cls}>
        <div className="cu-isect-cell">
          <span className="cu-isect-k">candidate prefix</span>
          <b className="cu-isect-prefix">
            {prefix ? `“${prefix}”` : '“”'}
            {prune && <i className="cu-isect-x">＋{prune.label}</i>}
          </b>
        </div>
        <div className="cu-isect-cell">
          <span className="cu-isect-k">character read</span>
          <b className={prune ? 'cu-isect-x' : undefined}>
            {last == null ? '—' : `“${last.label}”`}
          </b>
        </div>
        <div className="cu-isect-cell grow">
          {mode === 'term' ? (
            <>
              <span className="cu-isect-k">address in hand · the block to read when the arrows run out</span>
              <b className="cu-isect-prefix">
                {carried != null ? <>remember {hexAddr(carried)}</> : 'nothing yet'}
              </b>
            </>
          ) : (
            <>
              <span className="cu-isect-k">what “{pattern.raw}” accepts</span>
              <b className="cu-isect-prefix">
                {dfa.startAcceptsAnything
                  ? 'any character to begin with'
                  : `only “${pattern.seekPrefix[0]}” to begin with`}
              </b>
            </>
          )}
        </div>
        <div className={'cu-isect-verdict ' + verdict.cls}>
          {verdict.text}
          {prune && (
            <i>
              {prune.termsSkipped} term{prune.termsSkipped === 1 ? '' : 's'} behind it, never read
            </i>
          )}
        </div>
      </div>
    )
  }

  const grid = lev.grid
  const chips = [...lev.live]
    .map((id) => grid.nodes.find((n) => n.id === id))
    .filter((n) => n && !n.bridge)
    .sort((a, b) => a.e - b.e || a.i - b.i)

  const verdict = lev.dead
    ? { cls: 'dead', text: 'no state survived — PRUNE' }
    : lev.spentAnEdit
      ? { cls: 'edit', text: `+1 edit — ${lev.edits} of ${pattern.maxEdits} spent` }
      : { cls: 'exact', text: lev.char == null ? 'start' : 'the character was expected' }

  return (
    <div className={'cu-isect ' + verdict.cls}>
      <div className="cu-isect-cell">
        <span className="cu-isect-k">candidate prefix</span>
        <b className="cu-isect-prefix">
          {lev.prefix ? `“${lev.prefix}”` : '“”'}
          {lev.pruned && <i className="cu-isect-x">＋{lev.pruned.label}</i>}
        </b>
      </div>
      <div className="cu-isect-cell">
        <span className="cu-isect-k">character read</span>
        <b className={lev.pruned ? 'cu-isect-x' : undefined}>
          {lev.char == null ? '—' : `“${lev.char}”`}
        </b>
      </div>
      <div className="cu-isect-cell grow">
        <span className="cu-isect-k">
          automaton states · {chips.length || 'none'} alive
        </span>
        <span className="cu-isect-states">
          {chips.length ? (
            chips.map((n) => (
              <i
                key={n.id}
                className={'cu-isect-state' + (n.accept ? ' accept' : '') + (lev.entered.has(n.id) ? ' new' : '')}
              >
                {n.i},{n.e}
              </i>
            ))
          ) : (
            <i className="cu-isect-state none">∅</i>
          )}
        </span>
      </div>
      <div className={'cu-isect-verdict ' + verdict.cls}>
        {verdict.text}
        {lev.pruned && (
          <i>
            {lev.pruned.termsSkipped} term{lev.pruned.termsSkipped === 1 ? '' : 's'} behind it, never read
          </i>
        )}
        {!lev.dead && lev.accepting && <i>“{lev.prefix}” is already within budget</i>}
      </div>
    </div>
  )
}

