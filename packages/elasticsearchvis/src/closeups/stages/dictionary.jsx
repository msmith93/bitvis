import {
  BLOCK_MAX,
  LUCENE_BLOCK_MAX,
  LUCENE_BLOCK_MIN,
  buildTermIndex,
  seekTrace,
} from '../../blocktree'
import { compileAutomaton, intersectTrace } from '../../automaton'
import { parsePattern } from '../../wildcard'
import { AUTOMATON_STEP_MS, BLOCK_READ_MS, CU_DWELL_MS, FST_ARC_MS } from '../../timing'
import {
  ArcGraph,
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
// This is ONE PICTURE, not a slide deck. The FST (in memory) and the blocks it
// indexes (on disk) are both on screen for every step; a step only changes what
// is lit up on them. The same approach coordMerge.jsx takes with its persistent
// grid, and for the same reason: the layout is the lesson. Here the lesson is the
// RAM/disk split, so the split has to be the layout.
//
// The SAME picture serves both kinds of query, because a plain term is just the
// degenerate case of a pattern — one path through the FST, one block read:
//
//   term mode     spell the term out; the walk ends; one block is read.
//   pattern mode  the pattern's automaton drives the walk, following some arcs
//                 and pruning others; the surviving blocks are read.
//
// These were two separate close-ups. They drew the same two structures twice,
// so they were merged; see SPEC.md.

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
    'Follow one arrow per letter. A circle is the letters spelled so far. Whenever a circle carries an address, remember it — that is the last block that could still contain the term. All of this happens in memory.',
  read:
    'The arrows ran out, so the address you were carrying is the answer: the only block that can hold this term. It is read, and its rows are scanned in order. Every other block on the right is untouched.',
  found:
    'The row gives the term, how many documents contain it, and where its posting list starts in .doc. Note what never happened: the terms themselves were never loaded. The index that found it is the small graph on the left, and it never left memory.',
}

const PATTERN_BLURBS = {
  walk:
    'A pattern can match many terms, so instead of spelling one out, the query is turned into a little machine that says which characters are still acceptable. Run it along the arrows: an arrow it accepts is FOLLOWED, an arrow it rejects is PRUNED — and everything behind a pruned arrow is skipped without being read.',
  read:
    'Only the blocks the walk actually reached are read. Everything greyed out on the right was eliminated by the walk above — not by a shortcut or a guess, but because the pattern provably cannot match anything inside it.',
  found:
    'The terms that survived are the expansion: from here the wildcard is an ordinary OR over them. And the cost was decided entirely by where the pattern let the walk go.',
}

// A fuzzy is the same machine built from a different question — "what is within
// N edits" rather than "what fits this glob" — so it gets the same picture and
// only the wording changes.
const FUZZY_BLURBS = {
  walk:
    'The edit distance is compiled into a machine too: its states are “matched this much of the term, having spent this many edits”, and an arrow it can still afford is FOLLOWED while one it cannot is PRUNED. Nothing here is comparing strings — the automaton was built once and now just walks.',
  read:
    'Only the blocks the walk actually reached are read. With prefix_length 0 that tends to be all of them, because a machine allowed to spend an edit immediately cannot rule out any first character. Raise prefix_length and whole subtrees start going dark.',
  found:
    'The terms that survived are the expansion, and the query is now an ordinary OR over them. Read them carefully: edit distance is spelling, not meaning, so a term you never intended can be exactly as close as the one you did.',
}

export function build({ shard, segId, rows, term, patterns, anchor }) {
  const index = buildTermIndex(rows)
  const pattern = patterns?.find((p) => p.kind !== 'term') ?? null
  const mode = pattern ? 'pattern' : 'term'

  // One model per mode; both produce a replayable trace the stage folds into the
  // same picture.
  const alphabet = [...new Set(index.terms.flatMap((t) => [...t]))]
  const dfa = pattern ? compileAutomaton(pattern, alphabet) : null
  const hits = pattern ? intersectTrace(index, dfa) : null
  const trace =
    mode === 'term'
      ? { ...seekTrace(index, term), shardId: shard.id, segId }
      : null

  // The contrast that makes the leading-wildcard lesson structural rather than
  // asserted: the same dictionary, the other kind of pattern.
  const contrast = pattern ? buildContrast(index, alphabet, pattern) : null

  const units =
    mode === 'term'
      ? Math.max(1, trace.fst.arcs.length)
      : Math.max(1, hits.visits.filter((v) => v.action === 'follow' || v.action === 'prune').length)
  const rowCount = Math.max(1, trace?.inBlock?.rows.length ?? 1)
  const tick = mode === 'term' ? FST_ARC_MS : AUTOMATON_STEP_MS

  const steps = STEPS.map((s) => ({
    ...s,
    blurb:
      s.blurb ??
      (mode === 'term'
        ? TERM_BLURBS
        : pattern.kind === 'fuzzy'
          ? FUZZY_BLURBS
          : PATTERN_BLURBS)[s.key],
  }))
  const at = Object.fromEntries(steps.map((s, i) => [s.key, i]))
  const dwell = (i) => {
    if (i === at.walk) return Math.min(units, 40) * tick + 900
    if (i === at.read && mode === 'term') return rowCount * BLOCK_READ_MS + 900
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
    stageProps: { index, mode, trace, hits, dfa, pattern, contrast, term, at, tick },
  }
}

// Run the pattern's OPPOSITE over the same index, so step 4 can put the two
// costs side by side. Both numbers are derived, never written into copy.
//
// What "opposite" means depends on the kind, because each kind has its own
// version of the same question — can the walk be anchored at the front?
//   leading  `*search`  ↔ `search*`   the anchored glob
//   prefix   `sc*`      ↔ `*search`   a leading wildcard on this dictionary
//   fuzzy    prefix_length 0 ↔ 2      the SAME pattern, anchored or not, which is
//                                     the cleanest contrast of the three: one
//                                     knob, nothing else changed.
function buildContrast(index, alphabet, pattern) {
  let other
  if (pattern.kind === 'fuzzy') {
    // Flip prefix_length between 0 and 2 and re-parse, so the comparison isolates
    // the one thing that decides whether a fuzzy can be seeked.
    const flipped = pattern.prefixLength > 0 ? 0 : 2
    other = parsePattern(`${pattern.literal}~${pattern.maxEdits}`, {
      prefixLength: flipped,
    })
  } else {
    other = parsePattern(
      pattern.kind === 'leading' ? `${pattern.literal.replace(/^\*+/, '')}*` : '*search',
    )
  }
  if (!other.literal) return null
  const trace = intersectTrace(index, compileAutomaton(other, alphabet))
  return { pattern: other, trace }
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
}) {
  // Verdicts are what the pattern walk reveals; arcs are what the term walk
  // reveals. One counter either way.
  const verdicts =
    mode === 'pattern'
      ? hits.visits.filter((v) => v.action === 'follow' || v.action === 'prune')
      : []
  const total = mode === 'term' ? trace.fst.arcs.length : verdicts.length
  const walked = useReveal(step === at.walk && active, total, tick)
  const rows = useReveal(
    step === at.read && active && mode === 'term',
    trace?.inBlock?.rows.length ?? 0,
    BLOCK_READ_MS,
  )

  const walking = step >= at.walk
  const reading = step >= at.read
  const shown = step === at.walk ? walked : Infinity

  // What the picture highlights, per mode.
  let arcProps = {}
  let focusFp = null
  let expandedFp = null
  let loadedFps = null

  if (mode === 'term') {
    arcProps = { walk: walking ? trace.fst : null, revealed: shown }
    focusFp = walking ? trace.block?.fp ?? null : null
    expandedFp = reading ? trace.block?.fp ?? null : null
  } else {
    const followed = new Set()
    const pruned = new Set()
    for (const v of verdicts.slice(0, shown)) {
      const from = stateFor(index.fst, v.prefix)
      if (from != null) (v.action === 'follow' ? followed : pruned).add(`${from}:${v.label}`)
    }
    arcProps = walking ? { followed, pruned } : {}
    loadedFps = reading
      ? new Set(hits.visits.filter((v) => v.action === 'load').map((v) => v.fp))
      : null
  }

  return (
    <>
      <FileChain active={reading ? '.tim' : '.tip'} />

      <div className="si-scroll cu-scroll">
        <div className="cu-split">
          <section className="cu-side ram">
            <header className="cu-side-head">
              <span className="cu-side-title">in memory · .tip</span>
              <span className="cu-side-sub">the term index</span>
            </header>

            <ArcGraph fst={index.fst} index={index} {...arcProps} />

            {walking && mode === 'term' && (
              <SpellOut trace={trace} revealed={shown} />
            )}
            {walking && mode === 'pattern' && (
              <PatternWalk
                dfa={dfa}
                pattern={pattern}
                verdicts={verdicts.slice(0, shown)}
              />
            )}

            <footer className="cu-side-foot">
              <b>{index.fst.fstStates}</b> states ·{' '}
              <b>{index.fst.states.reduce((n, s) => n + s.arcs.length, 0)}</b> arcs
              <i>never leaves memory</i>
            </footer>
          </section>

          <section className="cu-side disk">
            <header className="cu-side-head">
              <span className="cu-side-title">on disk · .tim</span>
              <span className="cu-side-sub">
                {index.blocks.length} blocks
                {reading && (
                  <> · {mode === 'term' ? 1 : hits.blocksLoaded} read</>
                )}
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
        </div>

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

// The one line of copy that depends on where we are — kept below the picture so
// the picture itself never has to move.
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

  if (step === at.walk)
    return mode === 'term' ? (
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
    ) : (
      <CostLine tone={hits.prunesNothing ? 'warn' : 'good'}>
        {hits.prunedArcs} arc{hits.prunedArcs === 1 ? '' : 's'} pruned
        {hits.prunesNothing
          ? ' — nothing was eliminated, so every block below is still in play.'
          : `, and every term behind them is skipped unread.`}{' '}
        Still nothing read from disk.
      </CostLine>
    )

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
    <FoundPattern hits={hits} dfa={dfa} pattern={pattern} contrast={contrast} index={index} />
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

// The matched terms, and the same dictionary under the opposite kind of pattern.
function FoundPattern({ hits, dfa, pattern, contrast, index }) {
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
              <th>{pattern.kind === 'fuzzy' ? 'prefix_length' : 'pattern'}</th>
              <td>
                {pattern.kind === 'fuzzy' ? pattern.prefixLength : `“${pattern.raw}”`}
              </td>
              <td>
                {pattern.kind === 'fuzzy'
                  ? contrast.pattern.prefixLength
                  : `“${contrast.pattern.raw}”`}
              </td>
            </tr>
            <tr>
              <th>accepts any character to begin with</th>
              <td>{dfa.startAcceptsAnything ? 'yes' : 'no'}</td>
              <td>{contrast.trace.prunesNothing ? 'yes' : 'no'}</td>
            </tr>
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
          </tbody>
        </table>
      )}

      {pattern.kind === 'fuzzy' ? (
        <CostLine tone={dfa.startAcceptsAnything ? 'warn' : 'good'}>
          {dfa.startAcceptsAnything ? (
            <>
              With <b>prefix_length {pattern.prefixLength}</b> the machine may spend
              an edit on the very first character, so it accepts <b>any</b> of them
              and no arrow can be rejected. A fuzzy query is priced exactly like a
              leading wildcard, for exactly the same structural reason.
            </>
          ) : (
            <>
              <b>prefix_length {pattern.prefixLength}</b> forbids edits at the front,
              so the machine accepts only “{pattern.seekPrefix[0]}” to begin with and
              the rest of the dictionary is pruned unread. Same query, same edit
              budget — one knob.
            </>
          )}
        </CostLine>
      ) : (
        <CostLine tone="warn">
          A pattern that starts with a wildcard accepts <b>any</b> first character, so
          no arrow can ever be rejected and every block has to be read. That is the
          entire reason a leading wildcard is expensive — not a heuristic, just what
          the machine allows.
        </CostLine>
      )}
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
          <span key={i} className={'cu-verdict ' + v.action}>
            {v.action === 'prune' ? '✗' : '✓'} “{v.prefix}
            {v.label}”
            {v.action === 'prune' && <em>−{v.termsSkipped} terms</em>}
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

// Which FST state a prefix string ends on (null if the path doesn't exist).
function stateFor(fst, prefix) {
  let s = fst.root
  for (const ch of prefix) {
    const arc = fst.states[s].arcs.find((a) => a.label === ch)
    if (!arc) return null
    s = arc.to
  }
  return s
}
