import {
  BLOCK_MAX,
  LUCENE_BLOCK_MAX,
  LUCENE_BLOCK_MIN,
  buildTermIndex,
  seekTrace,
} from '../../blocktree'
import { ANY, compileAutomaton, intersectTrace } from '../../automaton'
import { editDistance, parsePattern, patternLabel } from '../../wildcard'
import { AUTOMATON_STEP_MS, BLOCK_READ_MS, CU_DWELL_MS, FST_ARC_MS } from '../../timing'
import {
  ArcGraph,
  AutomatonGrid,
  BlockColumn,
  CostLine,
  FileChain,
  SectionLabel,
  ToyBadge,
  hexAddr,
  useReveal,
} from '../shared'

// The deepest zoom, and deliberately a narrow one: how the index finds what a
// query is asking for without holding the term dictionary in memory.
//
// This is ONE PICTURE, not a slide deck. The structures are all on screen for
// every step; a step only changes what is lit up on them. The same approach
// coordMerge.jsx takes with its persistent grid, and for the same reason: the
// layout is the lesson.
//
// The SAME picture serves every kind of query, because a plain term is just the
// degenerate case of a pattern — one path through the FST, one block read:
//
//   term mode     spell the term out; the walk ends; one block is read.
//   pattern mode  the pattern's automaton drives the walk, following some arcs
//                 and pruning others; the surviving blocks are read.
//   fuzzy mode    the same walk, but the automaton is DRAWN beside the FST and
//                 the two move in lockstep.
//
// Why fuzzy gets the extra panel, when a wildcard does not: for a glob the
// interesting question is which arcs survived, and the FST alone answers it. For
// an edit-distance machine the interesting question is which (characters
// matched, edits spent) states are still alive — a SET, changing every
// character, that nothing in the FST can show you. So in fuzzy mode the .tim
// block column moves out of the split and becomes a full-width strip beneath it,
// and the split holds the two things that are actually in memory: the term index
// and the compiled query. The RAM/disk distinction is still drawn, still
// labelled, and still the reason the strip is mostly untouched.
//
// Term mode and pattern mode were once two separate close-ups. They drew the
// same two structures twice, so they were merged; see SPEC.md.

const STEPS = [
  {
    key: 'index',
    title: '1 · A small index over a big dictionary',
    blurb:
      'On the left is the whole term index, and it lives in memory. On the right are the blocks of terms, and they stay on disk. The point of the thing on the left is to avoid reading the things on the right — because at real scale the dictionary is far too large to keep resident.',
  },
  {
    key: 'walk',
    title: '2 · Follow the query through the index',
    blurb: null, // set per mode in build()
  },
  {
    key: 'read',
    title: '3 · Only what survives leaves the disk',
    blurb: null,
  },
  {
    key: 'found',
    title: '4 · What that bought you',
    blurb: null,
  },
]

const TERM_BLURBS = {
  walk:
    'Follow one arrow per letter — the arrows are the term, one character each. Whenever the node you land on carries an address, remember it: that is the last block that could still contain the term. All of this happens in memory.',
  read:
    'The arrows ran out, so the address you were carrying is the answer: the only block that can hold this term. It is read, and its rows are scanned in order. Every other block on the right is untouched.',
  found:
    'The row gives the term, how many documents contain it, and where its posting list starts in .doc. Note what never happened: the terms themselves were never loaded. The index that found it is the small graph on the left, and it never left memory.',
}

const PATTERN_BLURBS = {
  walk:
    'A pattern can match many terms, so instead of spelling one out, the query is turned into a little machine that says which characters are still acceptable. Watch it decide, arrow by arrow: green is an arrow it accepted, red is one it refused on sight — and everything behind a red arrow is skipped without ever being looked at.',
  read:
    'Only the blocks the walk actually reached are read. Everything greyed out on the right was eliminated by the walk above — not by a shortcut or a guess, but because the pattern provably cannot match anything inside it.',
  found:
    'The terms that survived are the expansion: from here the wildcard is an ordinary OR over them. And the cost was decided entirely by where the pattern let the walk go.',
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

const BLURBS = { term: TERM_BLURBS, pattern: PATTERN_BLURBS, fuzzy: FUZZY_BLURBS }

export function build({ shard, segId, rows, term, patterns, anchor }) {
  const index = buildTermIndex(rows)
  const pattern = patterns?.find((p) => p.kind !== 'term') ?? null
  const mode = pattern ? (pattern.kind === 'fuzzy' ? 'fuzzy' : 'pattern') : 'term'

  // One model per mode; all of them produce a replayable trace the stage folds
  // into the same picture.
  const alphabet = [...new Set(index.terms.flatMap((t) => [...t]))]
  const dfa = pattern ? compileAutomaton(pattern, alphabet) : null
  const hits = pattern ? intersectTrace(index, dfa) : null
  const trace =
    mode === 'term'
      ? { ...seekTrace(index, term), shardId: shard.id, segId }
      : null

  // The arc walk consumes BLOCK PREFIXES — a character or three — so it can never
  // reach an accepting state on its own; on this data `serch~` never gets past
  // "3 characters matched" of 5. The word is finished later, when a block is
  // read and its terms are tested one by one, and THAT is where the machine
  // lands on the right-hand column and accepts. Step 4 replays it for the term
  // that matched, because otherwise the grid looks stuck partway across and the
  // reader is left wondering how it ever decided anything.
  const matched = hits?.visits.find((v) => v.action === 'accept') ?? null

  // The contrast that makes the cost lesson structural rather than asserted: the
  // same dictionary, asked the opposite version of its own question.
  const contrast = pattern ? buildContrast(index, alphabet, pattern) : null

  // Which visits the walk step replays: every arc DECISION, followed or pruned.
  // A glob used to draw only its follows, on the theory that animating skipped
  // work was the opposite of the lesson. That was backwards — for `sc*` the
  // whole lesson IS that every arc but 's' dies at the root, and leaving those
  // undrawn made the cheapest pattern look identical to the most expensive one.
  // One replay, one set of rules, whatever the query.
  const walkVisits =
    mode === 'term'
      ? []
      : hits.visits.filter((v) => v.action === 'follow' || v.action === 'prune')

  const units = mode === 'term' ? Math.max(1, trace.fst.arcs.length) : Math.max(1, walkVisits.length)
  const rowCount = Math.max(1, trace?.inBlock?.rows.length ?? 1)
  const tick = mode === 'term' ? FST_ARC_MS : AUTOMATON_STEP_MS

  const steps = STEPS.map((s) => ({
    ...s,
    blurb: BLURBS[mode][s.key] ?? s.blurb,
  }))
  const at = Object.fromEntries(steps.map((s, i) => [s.key, i]))
  const dwell = (i) => {
    // Floored: a follows-only pattern walk can be three arcs long, which would
    // otherwise hurry the step past its own blurb.
    if (i === at.walk) return Math.max(CU_DWELL_MS, Math.min(units, 40) * tick + 900)
    if (i === at.read && mode === 'term') return rowCount * BLOCK_READ_MS + 900
    if (i === at.found && matched) return Math.max(CU_DWELL_MS, matched.path.steps.length * tick + 1200)
    return CU_DWELL_MS
  }

  const looking = mode === 'term' ? `“${term}”` : `“${pattern.raw}”`
  return {
    key: `dictionary-${shard.id}-${segId}-${mode === 'term' ? term : pattern.raw}`,
    title: (
      <>
        {segId} · the term index
        <span className="si-sub"> — finding {looking} without loading the dictionary</span>
      </>
    ),
    sub: `${segId} · .tip in memory, .tim on disk`,
    steps,
    dwell,
    source: anchor,
    className: 'cu-panel',
    Stage: DictionaryStage,
    stageProps: { index, mode, trace, hits, dfa, pattern, contrast, term, at, tick, walkVisits, matched },
  }
}

// Run the opposite kind of question over the same index, so step 4 can put the
// two costs side by side. Both numbers are derived, never written into copy.
//
// A glob's question is "can the walk be anchored at the front?". A fuzzy's is
// "what does one more edit of slack cost?" — and that contrast is the cleanest
// of the lot, because it is the same word against the same dictionary with a
// single number changed.
function buildContrast(index, alphabet, pattern) {
  const other =
    pattern.kind === 'fuzzy'
      ? // The same word with one more (or one fewer) edit of budget. That is
        // the only thing a fuzzy query really has to trade, and unlike the glob
        // contrast it changes nothing else at all.
        parsePattern(`${pattern.literal}~${pattern.maxEdits === 1 ? 2 : 1}`)
      : parsePattern(
          pattern.kind === 'leading' ? `${pattern.literal.replace(/^\*+/, '')}*` : '*search',
        )
  if (!other.literal) return null
  const dfa = compileAutomaton(other, alphabet)
  return { pattern: other, dfa, trace: intersectTrace(index, dfa) }
}

function DictionaryStage({
  step,
  active,
  index,
  mode,
  trace,
  hits,
  dfa,
  pattern,
  contrast,
  term,
  at,
  tick,
  walkVisits,
  matched,
}) {
  // One counter either way: arcs for a term walk, visits for a pattern walk.
  const total = mode === 'term' ? trace.fst.arcs.length : walkVisits.length
  const walked = useReveal(step === at.walk && active, total, tick)
  const rows = useReveal(
    step === at.read && active && mode === 'term',
    trace?.inBlock?.rows.length ?? 0,
    BLOCK_READ_MS,
  )
  // Step 4, fuzzy: the machine finishing the word it matched, one character at
  // a time, until it lands on an accepting state.
  const spelled = useReveal(
    step === at.found && active && mode === 'fuzzy' && !!matched,
    matched?.path.steps.length ?? 0,
    tick,
  )

  const walking = step >= at.walk
  const reading = step >= at.read
  const shown = step === at.walk ? walked : Infinity

  // What the picture highlights. A term walk spells one path out; a pattern walk
  // lights the arcs it took and reddens the ones it refused. Both carry a cursor
  // and therefore both pan (see ArcGraph) — the ONLY thing that varies by mode
  // is the automaton panel beside them, because a glob has no grid to draw.
  let arcProps = {}
  let focusFp = null
  let expandedFp = null
  let loadedFps = null
  let lev = null

  if (mode === 'term') {
    arcProps = { walk: walking ? trace.fst : null, revealed: shown }
    focusFp = walking ? trace.block?.fp ?? null : null
    expandedFp = reading ? trace.block?.fp ?? null : null
  } else {
    const revealed = walkVisits.slice(0, shown)
    const followed = new Set()
    const pruned = new Set()
    for (const v of revealed) {
      const key = `${v.fstFrom}:${v.label}`
      if (v.action === 'follow') followed.add(key)
      else pruned.add(key)
    }
    const last = revealed[revealed.length - 1] ?? null
    arcProps = walking
      ? {
          followed,
          pruned,
          dimmed: subtreeOf(index.fst, revealed.filter((v) => v.action === 'prune')),
          // The ring marks where the walk IS; the pan follows what the step is
          // ABOUT. For a prune those are different nodes, and the far end is the
          // one worth looking at.
          cursor: last ? (last.action === 'follow' ? last.fstTo : last.fstFrom) : index.fst.root,
          focus: last ? last.fstTo : index.fst.root,
        }
      : {}
    if (mode === 'fuzzy' && walking) lev = levView(dfa, revealed)
    if (mode === 'fuzzy' && matched && step === at.found) lev = levTermView(dfa, matched, spelled)
    loadedFps = reading
      ? new Set(hits.visits.filter((v) => v.action === 'load').map((v) => v.fp))
      : null
  }

  const fstSide = (
    <section className="cu-side ram" data-tour="fst">
      <header className="cu-side-head">
        <span className="cu-side-title">in memory · .tip</span>
        <span className="cu-side-sub">the term index</span>
      </header>

      <ArcGraph fst={index.fst} index={index} {...arcProps} />

      {walking && mode === 'term' && <SpellOut trace={trace} revealed={shown} />}
      {walking && mode === 'pattern' && (
        <PatternWalk
          dfa={dfa}
          pattern={pattern}
          verdicts={walkVisits.slice(0, shown)}
        />
      )}

      <footer className="cu-side-foot">
        <b>{index.fst.fstStates}</b> states ·{' '}
        <b>{index.fst.states.reduce((n, s) => n + s.arcs.length, 0)}</b> arcs
        <i>never leaves memory</i>
      </footer>
    </section>
  )

  const diskSide = (
    <section className={'cu-side disk' + (mode === 'fuzzy' ? ' cu-disk-strip' : '')}>
      <header className="cu-side-head">
        <span className="cu-side-title">on disk · .tim</span>
        <span className="cu-side-sub">
          {index.blocks.length} blocks
          {reading && <> · {mode === 'term' ? 1 : hits.blocksLoaded} read</>}
        </span>
      </header>

      <BlockColumn
        index={index}
        focusFp={focusFp}
        expandedFp={expandedFp}
        loadedFps={loadedFps}
        scan={trace?.inBlock}
        revealed={step === at.read ? rows : Infinity}
      />

      <footer className="cu-side-foot">
        <b>{index.terms.length}</b> terms ·{' '}
        <b>{index.terms.reduce((n, t) => n + t.length, 0)}</b> bytes of term text
        <i>stays on disk</i>
      </footer>
    </section>
  )

  return (
    <>
      <FileChain active={reading ? '.tim' : '.tip'} />

      <div className="si-scroll cu-scroll">
        {mode === 'fuzzy' ? (
          <>
            <div className="cu-split fuzzy">
              {fstSide}
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
            </div>

            <IntersectionReadout
              lev={lev}
              pattern={pattern}
              walking={walking}
              done={step > at.walk}
              hits={hits}
            />

            {diskSide}
          </>
        ) : (
          <div className="cu-split">
            {fstSide}
            {diskSide}
          </div>
        )}

        <StepNote
          step={step}
          at={at}
          mode={mode}
          index={index}
          trace={trace}
          hits={hits}
          dfa={dfa}
          pattern={pattern}
          contrast={contrast}
          term={term}
        />
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// The two cursors, folded out of the trace
// ---------------------------------------------------------------------------

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

  // Which drawn edges could have carried the walk from prevLive into live. A
  // deletion is an epsilon, so it fires INSIDE the new set rather than out of
  // the old one — which is exactly how it is drawn.
  const taken = new Set()
  if (char != null)
    for (const ed of grid.edges) {
      const ok =
        ed.kind === 'delete'
          ? live.has(ed.from) && live.has(ed.to)
          : prevLive.has(ed.from) &&
            live.has(ed.to) &&
            (ed.label === char || ed.label === ANY)
      if (ok) taken.add(`${ed.from}:${ed.to}:${ed.kind}`)
    }

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
    for (const ed of grid.edges) {
      const ok =
        ed.kind === 'delete'
          ? to.has(ed.from) && to.has(ed.to)
          : prev.has(ed.from) && to.has(ed.to) && (ed.label === st.ch || ed.label === ANY)
      if (ok) taken.add(`${ed.from}:${ed.to}:${ed.kind}`)
    }
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

// The transcript's third panel, as a strip: where both cursors are, what the
// automaton is currently able to be, and the verdict on the character just
// consumed. This is the piece that makes "intersection" mean something concrete
// — neither structure above can say it alone.
function IntersectionReadout({ lev, pattern, walking, done, hits }) {
  if (!lev) return null

  // Step 4: the machine finishing a word, rather than a cursor mid-walk.
  if (lev.spelling) {
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
  // The strip stays (so the layout doesn't jump) and totals up instead.
  if (done)
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
          <span className="cu-isect-k">terms within {pattern.maxEdits} edit{pattern.maxEdits === 1 ? '' : 's'}</span>
          <span className="cu-isect-states">
            {hits.matched.length ? (
              hits.matched.map((t) => (
                <i key={t} className="cu-isect-state accept">
                  {t}
                </i>
              ))
            ) : (
              <i className="cu-isect-state none">none</i>
            )}
          </span>
        </div>
        <div className="cu-isect-verdict done">
          {hits.termsRead} of {hits.termsTotal} terms read
          <i>{hits.blocksLoaded} of {hits.blocksTotal} blocks left the disk</i>
        </div>
      </div>
    )

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

// ---------------------------------------------------------------------------
// The one line of copy that depends on where we are — kept below the picture so
// the picture itself never has to move.
// ---------------------------------------------------------------------------

function StepNote({ step, at, mode, index, trace, hits, dfa, pattern, contrast, term }) {
  if (step === at.index)
    return (
      <>
        <CostLine>
          The index on the left has <b>{index.fst.fstStates} states</b> for a
          dictionary of <b>{index.terms.length} terms</b> — because it indexes{' '}
          <b>blocks</b>, not terms. It only has to get you to the right one of{' '}
          {index.blocks.length} blocks; the terms themselves stay on disk.
        </CostLine>
        {mode === 'fuzzy' && (
          <CostLine>
            The machine beside it has <b>{dfa.grid.nodes.length} states</b> before
            determinizing and <b>{dfa.states.length}</b> after — for a query of{' '}
            <b>{dfa.grid.n} characters</b> and <b>{dfa.grid.maxEdits} edit
            {dfa.grid.maxEdits === 1 ? '' : 's'}</b>. That is the whole of “within{' '}
            {dfa.grid.maxEdits} edit{dfa.grid.maxEdits === 1 ? '' : 's'} of “
            {pattern.literal}””, with nothing left over.
          </CostLine>
        )}
        <CostLine tone="warn">
          Our blocks hold {BLOCK_MAX} entries so the picture fits on a screen, which
          makes this look like a {(index.terms.length / index.blocks.length).toFixed(1)}×
          saving. Real Lucene packs {LUCENE_BLOCK_MIN}–{LUCENE_BLOCK_MAX} terms into
          each block, so a million-term field is indexed by tens of thousands of
          prefixes rather than a million — the demo badly understates it.{' '}
          <ToyBadge
            what="block size"
            here={BLOCK_MAX}
            lucene={`${LUCENE_BLOCK_MIN}–${LUCENE_BLOCK_MAX}`}
          />
        </CostLine>
      </>
    )

  if (step === at.walk) {
    if (mode === 'term')
      return (
        <CostLine tone={trace.outOfRange ? 'good' : undefined}>
          {trace.outOfRange ? (
            <>
              “{term}” sits outside this segment’s term range, so it is rejected here
              and now — <b>zero</b> disk reads.
            </>
          ) : (
            <>
              Every step of this is pointer-chasing in memory. Nothing has been read
              from disk yet.
            </>
          )}
        </CostLine>
      )

    return (
      <>
        <CostLine tone={hits.prunesNothing ? 'warn' : 'good'}>
          {hits.prunedArcs} arc{hits.prunedArcs === 1 ? '' : 's'} pruned
          {hits.prunesNothing ? (
            ' — nothing was eliminated, so every block below is still in play.'
          ) : (
            <>
              {' '}
              — the red ones. Nothing walked them, and the{' '}
              <b>{hits.termsPruned}</b> term{hits.termsPruned === 1 ? '' : 's'} behind
              them are skipped unread.
            </>
          )}{' '}
          Still nothing read from disk.
        </CostLine>
        {mode === 'fuzzy' && (
          <CostLine tone="warn">
            Note where the pruning is NOT: at the root. The machine still has its
            edit to spend, so it accepts <b>any</b> first character and no arc out
            of the root can be rejected — the same structural position a leading
            wildcard is in. Branches only start dying deeper in, once the budget
            has been spent and the automaton finally has something to refuse.
          </CostLine>
        )}
      </>
    )
  }

  if (step === at.read)
    return mode === 'term' ? (
      <CostLine tone="good">
        <b>1</b> of {index.blocks.length} blocks read. {trace.entriesRead} row
        {trace.entriesRead === 1 ? '' : 's'} compared inside it. The flat table one
        zoom up would have probed about <b>{trace.flatProbes}</b> places scattered
        across the whole dictionary.
      </CostLine>
    ) : (
      <CostLine tone={hits.blocksLoaded < hits.blocksTotal ? 'good' : 'warn'}>
        <b>{hits.blocksLoaded}</b> of {hits.blocksTotal} blocks read ·{' '}
        {hits.termsRead} of {hits.termsTotal} terms examined.
      </CostLine>
    )

  return mode === 'term' ? (
    <FoundTerm trace={trace} index={index} term={term} />
  ) : (
    <FoundPattern
      hits={hits}
      dfa={dfa}
      pattern={pattern}
      contrast={contrast}
      index={index}
      mode={mode}
    />
  )
}

function FoundTerm({ trace, index, term }) {
  if (!trace.found)
    return (
      <CostLine>
        “{term}” is not in this segment. One block was read to prove it — the index
        narrowed it to a single candidate, and it wasn’t there.
      </CostLine>
    )
  const e = trace.meta
  return (
    <>
      <div className="cu-meta">
        <SectionLabel note="the located row">Term entry</SectionLabel>
        <div className="cu-meta-grid">
          <span>term</span>
          <b>{e.term}</b>
          <span>appears in</span>
          <b>
            {e.docFreq} document{e.docFreq === 1 ? '' : 's'}
          </b>
          <span>.doc pointer</span>
          <b>{hexAddr(trace.block.fp)} → the list of which documents</b>
        </div>
      </div>
      <CostLine tone="good">
        {index.fst.fstStates} states in memory found one term among{' '}
        {index.terms.length}, reading <b>1</b> of {index.blocks.length} blocks. That
        ratio is the whole reason the term index exists — and it is what lets a
        field with millions of terms be searched by a process that could never hold
        them all.
      </CostLine>
    </>
  )
}

// The matched terms, and the same dictionary under the opposite question.
function FoundPattern({ hits, dfa, pattern, contrast, index, mode }) {
  const fuzzy = mode === 'fuzzy'
  return (
    <>
      <div className="cu-meta">
        <SectionLabel note={`${hits.termsRead} of ${hits.termsTotal} terms examined`}>
          “{pattern.raw}” expanded to
        </SectionLabel>
        <div className="cu-terms">
          {hits.matched.length ? (
            hits.matched.map((t) => (
              <span key={t} className="term-chip">
                {t}
                {fuzzy && (
                  <i className="term-chip-edits">
                    {editDistance(t, pattern.literal, pattern.maxEdits, pattern.transpositions)} edit
                  </i>
                )}
              </span>
            ))
          ) : (
            <div className="ss-none">no terms matched</div>
          )}
        </div>
      </div>

      {contrast && (
        <table className="cu-contrast">
          <tbody>
            <tr className="head">
              <th>{fuzzy ? 'edit budget' : 'pattern'}</th>
              <td>{fuzzy ? `${pattern.maxEdits} edit${pattern.maxEdits === 1 ? '' : 's'}` : `“${pattern.raw}”`}</td>
              <td>
                {fuzzy
                  ? `${contrast.pattern.maxEdits} edit${contrast.pattern.maxEdits === 1 ? '' : 's'}`
                  : `“${contrast.pattern.raw}”`}
              </td>
            </tr>
            {fuzzy ? (
              <tr>
                <th>states in the machine</th>
                <td>{dfa.states.length}</td>
                <td>{contrast.dfa.states.length}</td>
              </tr>
            ) : (
              <tr>
                <th>accepts any character to begin with</th>
                <td>{dfa.startAcceptsAnything ? 'yes' : 'no'}</td>
                <td>{contrast.trace.prunesNothing ? 'yes' : 'no'}</td>
              </tr>
            )}
            <tr>
              <th>arcs pruned</th>
              <td>{hits.prunedArcs}</td>
              <td>{contrast.trace.prunedArcs}</td>
            </tr>
            <tr>
              <th>blocks read</th>
              <td>
                {hits.blocksLoaded} of {hits.blocksTotal}
              </td>
              <td>
                {contrast.trace.blocksLoaded} of {contrast.trace.blocksTotal}
              </td>
            </tr>
            <tr>
              <th>terms examined</th>
              <td>
                {hits.termsRead} of {hits.termsTotal}
              </td>
              <td>
                {contrast.trace.termsRead} of {contrast.trace.termsTotal}
              </td>
            </tr>
            <tr>
              <th>terms matched</th>
              <td>{hits.matched.join(', ') || '—'}</td>
              <td>{contrast.trace.matched.join(', ') || '—'}</td>
            </tr>
          </tbody>
        </table>
      )}

      <CostLine tone="warn">
        {fuzzy ? (
          <>
            The two columns differ in one number: how many edits the query is
            allowed. Everything else — the word, the dictionary, the machinery —
            is identical. One more edit of slack buys more matches, and pays for
            them in states, in arcs the walk can no longer reject, and in blocks
            that have to leave the disk. That trade is the whole of what tuning a
            fuzzy query amounts to.
          </>
        ) : (
          <>
            A pattern that starts with a wildcard accepts <b>any</b> first character,
            so no arrow can ever be rejected and every block has to be read. That is
            the entire reason a leading wildcard is expensive — not a heuristic, just
            what the machine allows.
          </>
        )}
      </CostLine>
    </>
  )
}

// What the pattern will accept, and the verdicts as they land. This replaces a
// full DFA transition table, which rendered as a grid of mostly em-dashes and
// truncated its columns before reaching the characters that mattered.
function PatternWalk({ dfa, pattern, verdicts }) {
  return (
    <div className="cu-patwalk">
      <div className="cu-patwalk-head">
        “{pattern.raw}” accepts{' '}
        <b>
          {dfa.startAcceptsAnything
            ? 'any character to begin with'
            : `only “${pattern.seekPrefix[0]}” to begin with`}
        </b>
      </div>
      <div className="cu-verdicts">
        {verdicts.map((v, i) => (
          <span key={i} className="cu-verdict follow">
            ✓ “{v.prefix}
            {v.label}”
          </span>
        ))}
      </div>
    </div>
  )
}

// The walk, one line per letter, carrying the remembered address along. That
// "keep the last address you passed" step is the trick, and it needs saying.
function SpellOut({ trace, revealed }) {
  const shown = trace.fst.arcs.slice(0, revealed)
  let carried = null
  return (
    <div className="cu-spell">
      {shown.map((a, i) => {
        if (!a.missing && a.out != null) carried = a.out
        const at = trace.term.slice(0, i + 1)
        return (
          <div key={i} className={'cu-spell-row' + (a.missing ? ' dead' : '')}>
            <span className="cu-spell-letter">{a.label}</span>
            {a.missing ? (
              <span className="cu-spell-what">no arrow for “{a.label}” — stop</span>
            ) : (
              <>
                <span className="cu-spell-what">
                  at <b>“{at}”</b>
                </span>
                <span className="cu-spell-mem">
                  {a.out != null ? (
                    <>
                      remember <b>{hexAddr(a.out)}</b>
                    </>
                  ) : carried != null ? (
                    <>still holding {hexAddr(carried)}</>
                  ) : (
                    <>nothing yet</>
                  )}
                </span>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
