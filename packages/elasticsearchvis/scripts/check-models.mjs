// Assertions over the PURE models — the invariants SPEC.md states in prose and
// nothing else checks. Run with `npm run check`.
//
// There is no test runner in this repo on purpose (see CLAUDE.md): the
// deliverable is a screen-recordable app, verified by running it. That is still
// right for everything the app DRAWS. But the fuzzy layer is arithmetic, and a
// browser cannot tell you arithmetic is wrong — it will happily animate a
// confident, incorrect number at 260ms a step:
//
//   1. the two zoom levels agree on which terms a pattern matched
//   2. editDistance really is bounded Damerau-Levenshtein
//   3. Fuzziness.AUTO switches where Elasticsearch says it does
//   4. the automaton PICTURE describes the automaton that actually ran
//   5. the intersection trace's two cursors agree with the walk they describe
//   8. the postings and stored-fields tiles say what the levels above say
//
// Dependency-free and node-only. The app's imports are extensionless (Vite
// resolves them), so a small loader hook below does the same for node.

import { register } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolvePath(HERE, '../src') + '/'

const hookSrc = `
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
export async function resolve(spec, ctx, next) {
  if (!spec.startsWith('.')) return next(spec, ctx)
  try { return await next(spec, ctx) } catch (err) {
    for (const ext of ['.js', '.jsx', '/index.js']) {
      try {
        const r = await next(spec + ext, ctx)
        if (existsSync(fileURLToPath(r.url))) return r
      } catch {}
    }
    throw err
  }
}`
register(`data:text/javascript,${encodeURIComponent(hookSrc)}`, pathToFileURL(SRC))

const { analyzeDoc } = await import(SRC + 'analyzer.js')
const {
  routeShard,
  docRootId,
  isRootDoc,
} = await import(SRC + 'cluster.js')
const { SAMPLE_DOCS, FUZZY_QUERIES, WILDCARD_QUERIES, CATALOG_DOCS, NESTED_QUERIES } = await import(
  SRC + 'presets.js'
)
const { buildTermIndex, fstSeek, seekTrace } = await import(SRC + 'blocktree.js')
const { ANY, compileAutomaton, intersectTrace } = await import(SRC + 'automaton.js')
const { buildBlock, OBJECT_MAPPING, makeMapping } = await import(SRC + 'mapping.js')
const { scoreDoc, computeShardSearch, localSearchSteps } = await import(SRC + 'ops/search.js')
const searchOp = (await import(SRC + 'ops/search.js')).default
const { computeCoordinatorMerge } = await import(SRC + 'ops/search.js')
const { segmentInvertedIndex } = await import(SRC + 'invertedIndex.js')
const { buildPostings, postingsWalk } = await import(SRC + 'postings.js')
const { buildStoredFields, locateInShard, FDT_CHUNK_MAX } = await import(SRC + 'storedFields.js')
const { initialCluster, docRoute } = await import(SRC + 'cluster.js')
const W = await import(SRC + 'wildcard.js')

let failures = 0
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`)
function check(name, cond, detail) {
  if (cond) return ok(name)
  failures += 1
  console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? '\n      ' + detail : ''}`)
}
const section = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`)

// ---------------------------------------------------------------------------
// The dictionaries the app actually shows: one merged segment per shard, over
// the sample docs, routed exactly as the cluster routes them.
// ---------------------------------------------------------------------------
function shardDictionaries() {
  const byShard = new Map()
  SAMPLE_DOCS.forEach((d, n) => {
    const id = `doc-${n + 1}`
    const s = routeShard(d.routing || id)
    if (!byShard.has(s)) byShard.set(s, new Map())
    const tf = byShard.get(s)
    const tok = analyzeDoc(d)
    for (const t of [...tok.title, ...tok.body]) {
      if (!tf.has(t)) tf.set(t, new Set())
      tf.get(t).add(id)
    }
  })
  return [...byShard.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([shard, tf]) => {
      const rows = [...tf.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([term, ids]) => ({ term, docIds: [...ids], docFreq: ids.size }))
      return { shard, index: buildTermIndex(rows) }
    })
}

const DICTS = shardDictionaries()
const QUERIES = [...FUZZY_QUERIES, ...WILDCARD_QUERIES, 'serch~2', 'lucne~', 'search', 'se?rch*']
const PREFIX_LENGTHS = [0, 1, 2, 3]

// Every (query, prefix_length, segment) combination that is actually distinct.
function* combos() {
  for (const { shard, index } of DICTS) {
    const alphabet = [...new Set(index.terms.flatMap((t) => [...t]))]
    for (const q of QUERIES)
      for (const pl of PREFIX_LENGTHS) {
        const pattern = W.parsePattern(q, { prefixLength: pl })
        if (pattern.kind !== 'fuzzy' && pl > 0) continue // prefix_length is a fuzzy-only knob
        yield { shard, index, alphabet, q, pl, pattern }
      }
  }
}

// ---------------------------------------------------------------------------
section('1 · the two zoom levels agree on what matched')
// SPEC.md has always claimed the dictionary zoom's matched set and the flat
// scan one level up "can't drift apart". This is the thing that would notice.
// ---------------------------------------------------------------------------
{
  let n = 0
  const drift = []
  for (const { shard, index, alphabet, q, pl, pattern } of combos()) {
    n += 1
    const walk = intersectTrace(index, compileAutomaton(pattern, alphabet)).matched
    const flat = [...W.expandTerms(index.terms, [pattern])].sort()
    if (JSON.stringify(walk) !== JSON.stringify(flat))
      drift.push(`shard ${shard} “${q}” pl=${pl}: walk [${walk}] vs flat [${flat}]`)
  }
  check(
    `intersectTrace matched === expandTerms over ${n} combinations`,
    drift.length === 0,
    drift.slice(0, 4).join('\n      '),
  )
}

// ---------------------------------------------------------------------------
section('2 · editDistance is bounded Damerau-Levenshtein')
// ---------------------------------------------------------------------------
{
  // A deliberately dumb reference: full matrix, no bailout, no cleverness.
  const reference = (a, b, transpositions = true) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) =>
      Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
    )
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
        if (transpositions && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
      }
    return d[a.length][b.length]
  }

  const words = [
    '', 'a', 'ab', 'the', 'hte', 'cat', 'cart', 'car', 'cow', 'search', 'serch',
    'searched', 'searches', 'store', 'score', 'stores', 'lucene', 'lucne',
    'elasticsearch', 'segments',
  ]
  const wrong = []
  const wrongBounded = []
  for (const a of words)
    for (const b of words) {
      const want = reference(a, b)
      if (W.editDistance(a, b) !== want) wrong.push(`${a}/${b}: ${W.editDistance(a, b)} vs ${want}`)
      // The bounded form may return anything > max once it gives up, but its
      // VERDICT — within max or not — has to be identical. That verdict is the
      // only thing matchTerm ever asks it.
      for (const max of [0, 1, 2, 3])
        if (W.editDistance(a, b, max) <= max !== want <= max)
          wrongBounded.push(`${a}/${b} max=${max}`)
    }
  check(`unbounded distance matches a reference implementation (${words.length ** 2} pairs)`, wrong.length === 0, wrong.slice(0, 4).join('\n      '))
  check('the bounded form gives the same within-max verdict', wrongBounded.length === 0, wrongBounded.slice(0, 4).join('\n      '))
  check('a transposition costs one edit, not two', W.editDistance('hte', 'the') === 1)
  check('transpositions can be turned off', W.editDistance('hte', 'the', Infinity, false) === 2)
  check('the fuzzy preset chips are what the copy says they are',
    W.editDistance('serch', 'search') === 1 && W.editDistance('store', 'score') === 1)
}

// ---------------------------------------------------------------------------
section('3 · Fuzziness.AUTO switches where AUTO:3,6 says')
// ---------------------------------------------------------------------------
{
  const at = (n) => W.autoFuzziness('x'.repeat(n))
  check('0 edits below 3 characters', at(1) === 0 && at(2) === 0)
  check('1 edit from 3 to 5', at(3) === 1 && at(5) === 1)
  check('2 edits from 6 up', at(6) === 2 && at(12) === 2)
  check('a bare ~ takes AUTO', W.parsePattern('serch~').maxEdits === 1 && W.parsePattern('elastic~').maxEdits === 2)
  check('an explicit ~N is capped at MAX_EDITS', W.parsePattern('search~9').maxEdits === W.MAX_EDITS)
  check('~0 degrades to an exact term', W.parsePattern('ab~').kind === 'term')
  check('prefix_length becomes the seekPrefix', W.parsePattern('serch~', { prefixLength: 2 }).seekPrefix === 'se')
  check('prefix_length cannot exceed the term', W.parsePattern('serch~', { prefixLength: 9 }).prefixLength === 5)
}

// ---------------------------------------------------------------------------
section('4 · the drawn automaton is the automaton that ran')
// The dictionary close-up draws dfa.grid and lights states by their id out of
// dfa.states[...].nfaSet. If those two ever address different things the
// picture becomes a decoration that happens to move.
// ---------------------------------------------------------------------------
{
  const problems = []
  let n = 0
  for (const { shard, alphabet, q, pl, pattern } of combos()) {
    const dfa = compileAutomaton(pattern, alphabet)
    if (pattern.kind !== 'fuzzy') {
      if (dfa.grid !== null) problems.push(`shard ${shard} “${q}”: a glob should have no grid`)
      continue
    }
    n += 1
    const g = dfa.grid
    const where = `shard ${shard} “${q}” pl=${pl}`
    const byId = new Map(g.nodes.map((x) => [x.id, x]))

    if (byId.size !== g.nodes.length) problems.push(`${where}: duplicate node ids`)
    // Non-bridge coordinates must be exactly the id arithmetic the model uses.
    for (const x of g.nodes)
      if (!x.bridge && x.id !== x.e * (g.n + 1) + x.i)
        problems.push(`${where}: node ${x.id} is not at (${x.i},${x.e})`)
    for (const e of g.edges)
      if (!byId.has(e.from) || !byId.has(e.to))
        problems.push(`${where}: edge ${e.from}->${e.to} has no node`)
    // The claim the copy makes structurally: inside the pinned prefix there is
    // no way to spend an edit, so no edit edge may start there.
    for (const e of g.edges)
      if (e.kind !== 'match' && !byId.get(e.from).bridge && byId.get(e.from).i < g.prefixLength)
        problems.push(`${where}: a ${e.kind} edge starts inside the pinned prefix`)
    // Every state the DFA can light must be a state the picture can draw.
    for (const st of dfa.states)
      for (const id of st.nfaSet)
        if (!byId.has(id)) problems.push(`${where}: DFA state ${st.id} names undrawable NFA state ${id}`)
    // The accepting states are the ones that can still delete their way to the
    // end of the term inside the remaining budget.
    for (const x of g.nodes)
      if (!x.bridge && x.accept !== g.n - x.i <= g.maxEdits - x.e)
        problems.push(`${where}: node (${x.i},${x.e}) has the wrong accept flag`)
    if (dfa.capped) problems.push(`${where}: determinization hit the cap`)
  }
  check(`the grid model is consistent with its DFA over ${n} fuzzy automata`, problems.length === 0, problems.slice(0, 5).join('\n      '))
  check('a match edge is labelled with the character it consumes, an edit edge with ANY or nothing',
    [...combos()].filter((c) => c.pattern.kind === 'fuzzy').every(({ alphabet, pattern }) => {
      const g = compileAutomaton(pattern, alphabet).grid
      return g.edges.every((e) =>
        e.kind === 'match' || e.kind === 'transpose'
          ? typeof e.label === 'string' && e.label !== ANY
          : e.kind === 'delete'
            ? e.label === null
            : e.label === ANY,
      )
    }))
}

// ---------------------------------------------------------------------------
section('5 · the intersection trace reports the walk it performed')
// The close-up animates both panels straight off these cursors instead of
// re-walking the prefix itself. They have to be the same walk.
// ---------------------------------------------------------------------------
{
  const stateFor = (fst, prefix) => {
    let s = fst.root
    for (const ch of prefix) {
      const arc = fst.states[s].arcs.find((a) => a.label === ch)
      if (!arc) return null
      s = arc.to
    }
    return s
  }
  const problems = []
  let visits = 0
  for (const { shard, index, alphabet, q, pl, pattern } of combos()) {
    const dfa = compileAutomaton(pattern, alphabet)
    const hits = intersectTrace(index, dfa)
    for (const v of hits.visits) {
      if (v.action !== 'follow' && v.action !== 'prune') continue
      visits += 1
      const where = `shard ${shard} “${q}” pl=${pl} “${v.prefix}”+${v.label}`
      if (stateFor(index.fst, v.prefix) !== v.fstFrom) problems.push(`${where}: fstFrom disagrees with the prefix`)
      const arc = index.fst.states[v.fstFrom].arcs.find((a) => a.label === v.label)
      if (!arc || arc.to !== v.fstTo) problems.push(`${where}: fstTo is not where the arc points`)
      if (v.action === 'prune' && v.dfaTo !== null) problems.push(`${where}: a prune must have no surviving state`)
      if (v.action === 'follow' && dfa.states[v.dfaTo].dead) problems.push(`${where}: a follow landed on a dead state`)
    }
  }
  check(`both cursors agree with the walk over ${visits} arc decisions`, problems.length === 0, problems.slice(0, 4).join('\n      '))

  // The automaton panel lights the grid edges that carry the walk from the
  // visit's dfaFrom into its dfaTo. If no such edge exists the step animates a
  // state change with nothing moving — which is exactly what happened when the
  // view used the PREVIOUS visit's destination as the from-set instead of this
  // visit's own dfaFrom, and the depth-first walk backtracked.
  const unlit = []
  let follows = 0
  for (const { shard, index, alphabet, q, pl, pattern } of combos()) {
    if (pattern.kind !== 'fuzzy') continue
    const dfa = compileAutomaton(pattern, alphabet)
    const g = dfa.grid
    for (const v of intersectTrace(index, dfa).visits) {
      if (v.action !== 'follow') continue
      follows += 1
      const from = new Set(dfa.states[v.dfaFrom].nfaSet)
      const to = new Set(dfa.states[v.dfaTo].nfaSet)
      const lit = g.edges.some((e) =>
        e.kind === 'delete'
          ? to.has(e.from) && to.has(e.to)
          : from.has(e.from) && to.has(e.to) && (e.label === v.label || e.label === ANY),
      )
      if (!lit && unlit.length < 4) unlit.push(`shard ${shard} “${q}” pl${pl} on “${v.label}”`)
    }
  }
  check(`every followed arc lights at least one grid edge (${follows} follows)`, unlit.length === 0, unlit.join('\n      '))

  // Running the DFA over the whole term has to reach an accepting state for
  // exactly the terms matchTerm accepts. The read step animates that path, so a
  // disagreement would be a picture confidently showing the wrong verdict.
  const wrongVerdict = []
  let paths = 0
  for (const { shard, index, alphabet, q, pl, pattern } of combos()) {
    const dfa = compileAutomaton(pattern, alphabet)
    for (const v of intersectTrace(index, dfa).visits) {
      if (v.action !== 'accept' && v.action !== 'reject') continue
      paths += 1
      const want = v.action === 'accept'
      if (v.path.accepts !== want && wrongVerdict.length < 4)
        wrongVerdict.push(`shard ${shard} “${q}” pl${pl} term “${v.term}”: path says ${v.path.accepts}, matchTerm says ${want}`)
    }
  }
  check(`running the automaton over the whole term agrees with matchTerm (${paths} terms)`, wrongVerdict.length === 0, wrongVerdict.join('\n      '))

  // Term mode draws the intersection walk but reports the SEEK's cost, so the
  // two have to be the same walk over the same word. The follows must spell
  // exactly the arcs fstSeek took (a `missing` arc has no counterpart: the FST
  // indexes block prefixes, so the arrows always run out before the word does),
  // and the block the seek settles on must be one the intersection actually
  // loaded — otherwise the picture would halo a node the copy never read.
  //
  // Explicitly NOT asserted: equal block counts. TermsEnum.intersect loads a
  // block at every output-carrying state along the descent where seekExact
  // carries the last output and reads ONE, and that difference is by design —
  // it is why term mode keeps seekTrace for its numbers.
  {
    const mismatched = []
    let seeks = 0
    for (const { shard, index } of DICTS) {
      const alphabet = [...new Set(index.terms.flatMap((t) => [...t]))]
      for (const term of ['search', 'serch', 'lucene', 'zzz']) {
        seeks += 1
        const dfa = compileAutomaton(W.parsePattern(term), alphabet)
        const hits = intersectTrace(index, dfa)
        const walked = hits.visits.filter((v) => v.action === 'follow').map((v) => v.label)
        const sought = fstSeek(index, term).arcs.filter((a) => !a.missing).map((a) => a.label)
        const where = `shard ${shard} “${term}”`
        if (walked.join('') !== sought.join(''))
          mismatched.push(`${where}: walk spelled “${walked.join('')}”, seek spelled “${sought.join('')}”`)
        const trace = seekTrace(index, term)
        const loaded = new Set(hits.visits.filter((v) => v.action === 'load').map((v) => v.fp))
        if (trace.block && !loaded.has(trace.block.fp))
          mismatched.push(`${where}: the seek's block is not one the walk loaded`)
      }
    }
    check(
      `a term's drawn walk is the walk its seek performed (${seeks} seeks)`,
      mismatched.length === 0,
      mismatched.slice(0, 4).join('\n      '),
    )
  }

  // The reason the fuzzy scenario has a step 4 at all. The arc walk consumes
  // block PREFIXES, so it can never light an accepting state — a reader who
  // watches only the walk sees the grid stall partway across and concludes the
  // automaton never gets there. The view that finishes the word (termPath, and
  // levTermView which draws it) is the one that reaches the accepting column,
  // so assert BOTH halves: the walk never accepts, and the finishing path does.
  for (const { shard, index } of DICTS) {
    const alphabet = [...new Set(index.terms.flatMap((t) => [...t]))]
    const dfa = compileAutomaton(W.parsePattern('serch~'), alphabet)
    const hits = intersectTrace(index, dfa)
    const accepts = (id) =>
      id != null && dfa.states[id].nfaSet.some((n) => dfa.grid.nodes.find((g) => g.id === n)?.accept)
    const walkAccepted = hits.visits.filter((v) => v.action === 'follow' && accepts(v.dfaTo)).length
    const finished = hits.visits.filter((v) => v.action === 'accept' && v.path.accepts && accepts(v.path.end))
    check(
      `shard ${shard}: only the finishing path reaches an accepting state`,
      walkAccepted === 0 && finished.length > 0,
      `${walkAccepted} walk visits accepted (want 0), ${finished.length} finished paths accepted (want >0)`,
    )
  }

  // The guided walk explains every prune with the SAME sentence: "every reading
  // still alive has already spent its edit, so only the exact character each one
  // is waiting for could keep it going". That is not a turn of phrase — it is
  // forced by the machine. A reading with budget left can always buy the next
  // character as an INSERTION (cost 1, consumes anything), so while any live
  // reading has budget no arc can die. If that ever stopped holding, the
  // narration would be confidently wrong about why the dictionary got pruned.
  {
    const wrong = []
    let prunes = 0
    for (const { shard, index } of DICTS) {
      const alphabet = [...new Set(index.terms.flatMap((t) => [...t]))]
      for (const q of ['serch~', 'store~1', 'search~2']) {
        const pattern = W.parsePattern(q)
        if (pattern.kind !== 'fuzzy') continue
        const dfa = compileAutomaton(pattern, alphabet)
        const grid = dfa.grid
        const byId = new Map(grid.nodes.map((n) => [n.id, n]))
        for (const v of intersectTrace(index, dfa).visits) {
          if (v.action !== 'prune') continue
          prunes += 1
          const from = (dfa.states[v.dfaFrom]?.nfaSet ?? [])
            .map((x) => byId.get(x))
            .filter((n) => n && !n.bridge)
          const withBudget = from.filter((n) => n.e < grid.maxEdits)
          if (withBudget.length && wrong.length < 4)
            wrong.push(
              `shard ${shard} “${q}” “${v.prefix}”+${v.label}: ` +
                `(${withBudget[0].i},${withBudget[0].e}) still had budget yet the arc was pruned`,
            )
        }
      }
    }
    check(
      `a fuzzy arc only dies once every live reading is out of edits (${prunes} prunes)`,
      wrong.length === 0,
      wrong.join('\n      '),
    )
  }

  // The fuzzy scenario hands the walk to the reader and advances its own steps
  // on how far they have scrubbed: one tip clears at 3 decisions, the next at
  // 6. Those numbers are only meaningful if a prune has actually appeared on
  // screen by then — otherwise the step that says "watch one turn RED" clears
  // itself before anything has. Both are properties of the DATASET (which arcs
  // the walk meets first), so they belong here rather than in the scenario.
  for (const { shard, index } of DICTS) {
    const alphabet = [...new Set(index.terms.flatMap((t) => [...t]))]
    const dfa = compileAutomaton(W.parsePattern('serch~'), alphabet)
    const decisions = intersectTrace(index, dfa).visits.filter(
      (v) => v.action === 'follow' || v.action === 'prune',
    )
    // `revealed = walkVisits.slice(0, sub)`, so a tip clearing at sub === n has
    // shown decisions 0..n-1.
    const prunesBy = (n) => decisions.slice(0, n).filter((v) => v.action === 'prune').length
    check(
      `shard ${shard}: the fuzzy walk shows a prune within the tour's first 3 steps`,
      prunesBy(3) >= 1 && prunesBy(6) >= 2,
      `${prunesBy(3)} prunes in the first 3 decisions (want >=1), ${prunesBy(6)} in the first 6 (want >=2)`,
    )
  }

  // The scenario's whole payoff is that a DEFAULT fuzzy query visibly prunes.
  // That is a property of the DATASET, not of the algorithm, and it is easy to
  // destroy by editing presets.js — the previous fourteen-document set pruned
  // zero arcs on shard 0 and read 100% of it. Guard it on every shard.
  for (const { shard, index } of DICTS) {
    const alphabet = [...new Set(index.terms.flatMap((t) => [...t]))]
    const h = intersectTrace(index, compileAutomaton(W.parsePattern('serch~'), alphabet))
    check(
      `shard ${shard}: a default fuzzy prunes, and finds the typo`,
      h.prunedArcs >= 5 && h.termsRead < h.termsTotal && h.matched.includes('search'),
      `${h.prunedArcs} arcs pruned, ${h.termsRead}/${h.termsTotal} terms read, matched [${h.matched}]`,
    )
  }
}

// ---------------------------------------------------------------------------
section('6 · the sample dataset keeps its other jobs')
// SAMPLE_DOCS is load-bearing for three scenarios at once. These are the facts
// the fuzzy expansion could plausibly have broken.
// ---------------------------------------------------------------------------
{
  const { analyzeDoc: an } = await import(SRC + 'analyzer.js')
  const tf = (d, term) => { const t = an(d); return [...t.title, ...t.body].filter((x) => x === term).length }

  const searchCounts = SAMPLE_DOCS.map((d, i) => [`doc-${i + 1}`, tf(d, 'search')]).filter(([, n]) => n)
  check('the shard-0 top-k demo still has its 4/3/2/1 spread',
    ['doc-2', 'doc-11', 'doc-5', 'doc-8'].map((id) => searchCounts.find(([x]) => x === id)?.[1]).join(',') === '4,3,2,1',
    searchCounts.map(([id, n]) => `${id}x${n}`).join(' '))
  check('no document added after doc-14 contains the bare term "search"',
    SAMPLE_DOCS.slice(14).every((d) => tf(d, 'search') === 0))

  for (const { shard, index } of DICTS) {
    const alphabet = [...new Set(index.terms.flatMap((t) => [...t]))]
    const leading = intersectTrace(index, compileAutomaton(W.parsePattern('*search'), alphabet)).matched
    check(`shard ${shard}: "*search" still matches exactly search + elasticsearch`,
      JSON.stringify(leading) === JSON.stringify(['elasticsearch', 'search']), `[${leading}]`)
    const prefix = intersectTrace(index, compileAutomaton(W.parsePattern('sc*'), alphabet)).matched
    check(`shard ${shard}: "sc*" still has a range to walk`, prefix.length >= 3, `[${prefix}]`)
  }

  // The false-positive beat the fuzzy scenario closes on.
  const hits = DICTS.flatMap(({ index }) => {
    const alphabet = [...new Set(index.terms.flatMap((t) => [...t]))]
    return intersectTrace(index, compileAutomaton(W.parsePattern('store~1'), alphabet)).matched
  })
  check('"store~1" still finds "score" — the word nobody asked for', hits.includes('score'), `[${[...new Set(hits)]}]`)
}

// ---------------------------------------------------------------------------
section('7 · object vs nested mapping')
// The whole lesson in one dataset: CATALOG_DOCS indexed twice, once under
// OBJECT_MAPPING (every sub-object flattened into its parent, one Lucene doc)
// and once under makeMapping(['variants']) (every variant its own Lucene doc,
// root last). Same source JSON, same ids, same routing — the mapping is the
// only variable.
// ---------------------------------------------------------------------------
{
  const NESTED_MAPPING = makeMapping(['variants'])

  // One source doc -> its block, id doc-1..doc-12 in array order, routed
  // exactly as the cluster routes anything else.
  function buildCatalog(mapping) {
    const docs = {} // luceneId -> Lucene doc
    const blocks = [] // { id, shard, block } in array order
    CATALOG_DOCS.forEach((source, n) => {
      const id = `doc-${n + 1}`
      const block = buildBlock(source, { id, mapping })
      for (const d of block) docs[d.id] = d
      blocks.push({ id, shard: routeShard(id), block })
    })
    return { docs, blocks }
  }

  const OBJ = buildCatalog(OBJECT_MAPPING)
  const NEST = buildCatalog(NESTED_MAPPING)

  // 1. No real red XL exists — the invariant the whole lesson rests on.
  const realRedXL = CATALOG_DOCS.filter((d) => d.variants.some((v) => v.color === 'red' && v.size === 'XL'))
  check(
    'no product has a single variant that is both red and XL',
    realRedXL.length === 0,
    realRedXL.map((d) => d.name).join(', '),
  )

  // 2. Exactly one product holds red and XL on DIFFERENT variants: doc-2.
  const splitRedXL = CATALOG_DOCS.map((d, n) => ({ id: `doc-${n + 1}`, d }))
    .filter(
      ({ d }) => d.variants.some((v) => v.color === 'red') && d.variants.some((v) => v.size === 'XL'),
    )
    .map(({ id }) => id)
  check(
    'exactly one product holds red and XL on different variants, and it is doc-2',
    splitRedXL.length === 1 && splitRedXL[0] === 'doc-2',
    `[${splitRedXL}]`,
  )

  // 3. The false positive: object mapping loses the pairing between a
  // variant's fields, so a query for red AND XL matches a Lucene doc that is
  // neither. Nested keeps each variant its own doc, so no single Lucene doc
  // ever holds both clauses and the trap matches nothing.
  {
    const patterns = W.parseQuery(NESTED_QUERIES[0]) // "variants.color:red AND variants.size:XL"
    const objHits = Object.values(OBJ.docs).filter((d) => scoreDoc(d, patterns).score > 0)
    const nestHits = Object.values(NEST.docs).filter((d) => scoreDoc(d, patterns).score > 0)
    check(
      'object: the red+XL trap matches exactly one Lucene doc, rooted at doc-2',
      objHits.length === 1 && docRootId(objHits[0]) === 'doc-2',
      `hits: [${objHits.map((d) => d.id)}]`,
    )
    check(
      'nested: the red+XL trap matches zero Lucene docs',
      nestHits.length === 0,
      `hits: [${nestHits.map((d) => d.id)}]`,
    )
  }

  // 4. The control query — a pair that really does live on ONE variant, and
  // whose two values never appear on different variants of the same product.
  // Both mappings must return exactly that product, or nested would just be
  // breaking queries rather than fixing a false positive. Brown is the only
  // colour rare enough to give that guarantee; red would not, because several
  // products carry red and S on different variants.
  {
    const patterns = W.parseQuery(NESTED_QUERIES[1]) // "variants.color:brown AND variants.size:M"
    const objHits = Object.values(OBJ.docs).filter((d) => scoreDoc(d, patterns).score > 0)
    const nestHits = Object.values(NEST.docs).filter((d) => scoreDoc(d, patterns).score > 0)
    const objRoots = [...new Set(objHits.map(docRootId))].sort()
    const nestRoots = [...new Set(nestHits.map(docRootId))].sort()
    check(
      'the brown+M control is unambiguous: only one variant in the catalog is brown',
      CATALOG_DOCS.flatMap((p) => p.variants).filter((v) => v.color === 'brown').length === 1,
    )
    check(
      'object: the brown+M control matches exactly doc-11',
      objRoots.length === 1 && objRoots[0] === 'doc-11',
      `roots: [${objRoots}]`,
    )
    check(
      'nested: the brown+M control matches the same document, via a CHILD',
      nestRoots.length === 1 &&
        nestRoots[0] === 'doc-11' &&
        nestHits.every((d) => !isRootDoc(d)),
      `hits: [${nestHits.map((d) => `${d.id}(root=${docRootId(d)})`)}]`,
    )
    check(
      'the two mappings agree on the control — nested did not break the query',
      objRoots.join() === nestRoots.join(),
      `object [${objRoots}] vs nested [${nestRoots}]`,
    )
  }

  // 5. Block shape. Nested: every block is variants.length+1 docs, the LAST
  // is the root, every other entry is a child rooted at it. Object: every
  // block is exactly one doc.
  {
    const shapeProblems = []
    for (const { id, block } of NEST.blocks) {
      const source = CATALOG_DOCS[Number(id.slice('doc-'.length)) - 1]
      if (block.length !== source.variants.length + 1)
        shapeProblems.push(`${id}: block has ${block.length} docs, want ${source.variants.length + 1}`)
      const root = block[block.length - 1]
      if (!isRootDoc(root)) shapeProblems.push(`${id}: last entry is not the root`)
      for (const child of block.slice(0, -1)) {
        if (isRootDoc(child)) shapeProblems.push(`${id}: a non-last entry is a root`)
        if (docRootId(child) !== root.id) shapeProblems.push(`${id}: ${child.id}'s root is not ${root.id}`)
      }
    }
    check(
      'nested: every block is variants.length+1 docs, root last, children pointing at it',
      shapeProblems.length === 0,
      shapeProblems.slice(0, 4).join('\n      '),
    )

    const objProblems = OBJ.blocks
      .filter(({ block }) => block.length !== 1)
      .map(({ id, block }) => `${id}: ${block.length} docs`)
    check('object: every block is exactly 1 Lucene doc', objProblems.length === 0, objProblems.slice(0, 4).join('\n      '))
  }

  // 6. Segment arithmetic on shard 0: doc-2/5/8/11, one segment per mapping,
  // blocks concatenated in order. maxDoc counts every Lucene doc; numDocs
  // counts only live roots, i.e. Elasticsearch documents — that count must
  // not move when only the mapping changes.
  {
    const shard0Ids = ['doc-2', 'doc-5', 'doc-8', 'doc-11']
    check(
      'doc-2, doc-5, doc-8, doc-11 really do route to shard 0',
      shard0Ids.every((id) => routeShard(id) === 0),
      shard0Ids.map((id) => `${id}->shard${routeShard(id)}`).join(' '),
    )

    const segFor = ({ blocks }) => ({
      docIds: shard0Ids.flatMap((id) => blocks.find((b) => b.id === id).block.map((d) => d.id)),
    })
    const objSeg = segFor(OBJ)
    const nestSeg = segFor(NEST)

    const luceneDocs = (seg) => seg.docIds.length
    const esDocs = (seg, docs) => seg.docIds.filter((id) => isRootDoc(docs[id])).length

    check(
      'shard-0 segment: 4 Lucene docs under object, 17 under nested',
      luceneDocs(objSeg) === 4 && luceneDocs(nestSeg) === 17,
      `object=${luceneDocs(objSeg)}, nested=${luceneDocs(nestSeg)}`,
    )
    check(
      'shard-0 segment: 4 Elasticsearch documents under BOTH — only the Lucene count moves',
      esDocs(objSeg, OBJ.docs) === 4 && esDocs(nestSeg, NEST.docs) === 4,
      `object=${esDocs(objSeg, OBJ.docs)}, nested=${esDocs(nestSeg, NEST.docs)}`,
    )
    check(
      'nested shard-0 segment: the last Lucene doc is a root — a block always ends on its root',
      isRootDoc(NEST.docs[nestSeg.docIds[nestSeg.docIds.length - 1]]),
    )
  }

  // 7. The block join, asserted against the code that actually RUNS it —
  // computeShardSearch, the same function the shard close-up renders. A
  // parentBitset/nextSetBit pair was asserted here instead and was removed
  // along with the diagram it backed: nothing in the app called either, so
  // this was checking a parallel implementation rather than the real path.
  {
    const patterns = W.parseQuery(NESTED_QUERIES[1]) // brown + M -> Dune Boot (doc-11, shard 0)
    const shard0 = {
      segments: [
        {
          id: 'seg-1',
          searchable: true,
          docIds: ['doc-2', 'doc-5', 'doc-8', 'doc-11'].flatMap((id) =>
            NEST.blocks.find((b) => b.id === id).block.map((d) => d.id),
          ),
        },
      ],
    }
    const local = computeShardSearch(shard0, patterns, NEST.docs)

    check(
      'the join runs: the match is on a CHILD, not on the document asked about',
      local.joins.length === 1 && !isRootDoc(NEST.docs[local.joins[0].child]),
      `joins: [${local.joins.map((j) => `${j.child}->${j.root}`)}]`,
    )
    const badJoin = local.joins.filter((j) => j.root !== docRootId(NEST.docs[j.child]))
    check(
      'every join lands on the root of the block the matching child belongs to',
      badJoin.length === 0,
      badJoin.map((j) => `${j.child} -> ${j.root}`).join(' '),
    )
    check(
      'the shard reports the DOCUMENT, not the variant that matched',
      local.scored.length === 1 && local.scored[0].docId === 'doc-11',
      `scored: [${local.scored.map((x) => x.docId)}]`,
    )
    check(
      'a flat dataset needs no join at all — every Lucene doc is already its own root',
      OBJ.blocks.every(({ block }) => block.every((d) => docRootId(d) === d.id)),
    )

    // The join step has to have an N-to-1 collapse to DRAW, or it renders as a
    // column of 1 -> 1 rows and shows nothing merging. Trail Runner carries two
    // out-of-stock variants for exactly this reason.
    const stock = W.parseQuery(NESTED_QUERIES[2]) // variants.stock:0
    const localStock = computeShardSearch(shard0, stock, NEST.docs)
    const perRoot = new Map()
    for (const j of localStock.joinRows) perRoot.set(j.root, j.from.length)
    check(
      'variants.stock:0 gives the join a real N-to-1 collapse: doc-2 merges 2 Lucene docs',
      perRoot.get('doc-2') === 2,
      `joinRows: ${[...perRoot].map(([r, n]) => `${r}<-${n}`).join(' ')}`,
    )

    // The nested scenario waits on specific panel step indices before it speaks
    // (PANEL_INTERSECT / PANEL_JOIN in src/scenarios/nested.js). If the shard
    // panel's step list ever changes shape, the tour would point at the wrong
    // thing and nothing else would notice — so pin the indices here.
    const keys = (q, blocks) =>
      localSearchSteps(W.parseQuery(q), { blocks }).map((x) => x.key)
    const nestedKeys = keys(NESTED_QUERIES[1], true)
    const objectKeys = keys(NESTED_QUERIES[0], false)
    check(
      "the tour's panel step indices still hold: intersect at 3, join at 4",
      nestedKeys[3] === 'intersect' && nestedKeys[4] === 'join' && objectKeys[3] === 'intersect',
      `nested [${nestedKeys}] object [${objectKeys}]`,
    )
    check(
      'a plain, single-clause query on flat data gains neither step',
      keys('search', false).join() === 'analyze,lookup,postings,score,topk,return',
      keys('search', false).join(),
    )

  }

  // 8. A single-clause query needs no join distinction: object and nested
  // both find the same PRODUCTS (doc-2, doc-5), even though nested is scoring
  // at the child-doc level under the hood.
  {
    const patterns = W.parseQuery(NESTED_QUERIES[2]) // "variants.stock:0"
    const objHits = Object.values(OBJ.docs).filter((d) => scoreDoc(d, patterns).score > 0)
    const nestHits = Object.values(NEST.docs).filter((d) => scoreDoc(d, patterns).score > 0)
    check('object: variants.stock:0 matches', objHits.length > 0, `hits: [${objHits.map((d) => d.id)}]`)
    check('nested: variants.stock:0 matches', nestHits.length > 0, `hits: [${nestHits.map((d) => d.id)}]`)
    check(
      'object: variants.stock:0 matches exactly 2 Lucene docs (doc-2, doc-5)',
      objHits.length === 2 && objHits.every((d) => docRootId(d) === d.id) && objHits.map((d) => d.id).sort().join(',') === 'doc-2,doc-5',
      `hits: [${objHits.map((d) => d.id)}]`,
    )
    const roots = new Set(nestHits.map((d) => docRootId(d)))
    check(
      'nested: variants.stock:0 rolls up to exactly 2 distinct roots (doc-2, doc-5)',
      roots.size === 2 && [...roots].sort().join(',') === 'doc-2,doc-5',
      `roots: [${[...roots]}]`,
    )
  }
}

// ---------------------------------------------------------------------------
section('8 · the postings and stored-fields tiles agree with the levels above')
// The segment close-up's last two tiles draw src/postings.js and
// src/storedFields.js. A posting is an ORDINAL with a FREQUENCY; the ordinal
// must be the doc's index in seg.docIds (cluster.js's definition) and the
// frequency the count scoreDoc uses — otherwise the tile animates numbers the
// shard close-up above it would contradict. The stored-fields rows are
// addressed by that same ordinal, the root is the LAST row of its block, and
// only a root carries _source. And the fetch close-up's resolution of a winner
// to (segment, ordinal) has to land on exactly one segment.
// ---------------------------------------------------------------------------
{
  // The same seeding App.loadDataset does: blocks routed as the cluster routes
  // them, ~3 segments per shard, every segment searchable.
  function seed(source, mapping) {
    const c = initialCluster()
    const byShard = Object.fromEntries(c.shards.map((s) => [s.id, []]))
    source.forEach((d, i) => {
      const id = `doc-${i + 1}`
      const { routing, ...fields } = d
      const block = buildBlock(fields, { id, mapping, routing, shard: docRoute({ id, routing }) })
      for (const ld of block) c.docs[ld.id] = ld
      byShard[block[0].shard].push(block)
    })
    let seg = 1
    for (const shard of c.shards) {
      const blocks = byShard[shard.id]
      const per = Math.max(2, Math.ceil(blocks.length / 3))
      for (let j = 0; j < blocks.length; j += per)
        shard.segments.push({
          id: `seg-${seg++}`,
          docIds: blocks.slice(j, j + per).flatMap((b) => b.map((ld) => ld.id)),
          searchable: true,
          committed: true,
        })
    }
    return c
  }
  const SAMPLE = seed(SAMPLE_DOCS, OBJECT_MAPPING)
  const NESTED = seed(CATALOG_DOCS, makeMapping(['variants']))
  const CLUSTERS = [['sample', SAMPLE], ['catalog-nested', NESTED]]

  // 1. postings: ordinal = index in seg.docIds, docFreq = list length, freq =
  //    scoreDoc's per-term count, lists in ordinal order.
  for (const [name, c] of CLUSTERS) {
    let bad = []
    let n = 0
    for (const shard of c.shards)
      for (const seg of shard.segments) {
        const rows = segmentInvertedIndex(seg, c.docs)
        const p = buildPostings(seg, rows, c.docs)
        for (const term of p.order) {
          const list = p.byTerm.get(term)
          if (list.docFreq !== list.entries.length) bad.push(`${seg.id} ${term}: docFreq`)
          let prev = -1
          for (const e of list.entries) {
            n += 1
            if (seg.docIds[e.ord] !== e.id) bad.push(`${seg.id} ${term}: ord ${e.ord} ≠ ${e.id}`)
            if (e.ord <= prev) bad.push(`${seg.id} ${term}: not in ordinal order`)
            prev = e.ord
            if (/[*?~:\s]/.test(term)) continue
            const sc = scoreDoc(c.docs[e.id], W.parseQuery(term))
            if ((sc.perTerm[term] ?? 0) !== e.freq) bad.push(`${seg.id} ${term}@${e.id}: freq ${e.freq} vs scoreDoc ${sc.perTerm[term]}`)
          }
        }
        if (p.total !== rows.reduce((k, r) => k + r.docIds.length, 0)) bad.push(`${seg.id}: total`)
      }
    check(`${name}: every posting is (ordinal in seg.docIds, scoreDoc's frequency), lists in ordinal order (${n} postings)`,
      bad.length === 0, bad.slice(0, 5).join('; '))
  }

  // 2. the walk the postings step replays for "search" on shard 0 is the 4/3/2/1
  //    docs the top-k demo is tuned on, in ordinal order across segments.
  {
    const shard0 = SAMPLE.shards[0]
    const got = []
    for (const seg of shard0.segments) {
      const p = buildPostings(seg, segmentInvertedIndex(seg, SAMPLE.docs), SAMPLE.docs)
      const w = postingsWalk(p, ['search'])
      check(`${seg.id}: postingsWalk("search") has units = docFreq and one entry per posting`,
        w.units === (p.byTerm.get('search')?.docFreq ?? 0) && w.order.length === w.units &&
          w.order.every((e, i) => e.i === i))
      for (const e of w.order) got.push(`${e.id}x${e.freq}`)
    }
    check('shard 0: the "search" lists carry the 4/3/2/1 frequencies',
      ['doc-2x4', 'doc-11x3', 'doc-5x2', 'doc-8x1'].every((x) => got.includes(x)), got.join(' '))
  }

  // 3. stored fields: rows by ordinal, root last in its block, _source on roots
  //    only, chunks partition the ordinals.
  for (const [name, c] of CLUSTERS) {
    let bad = []
    for (const shard of c.shards)
      for (const seg of shard.segments) {
        const sf = buildStoredFields(seg, c.docs)
        if (sf.maxDoc !== seg.docIds.length) bad.push(`${seg.id}: maxDoc`)
        sf.rows.forEach((r, i) => {
          if (r.ord !== i || r.id !== seg.docIds[i]) bad.push(`${seg.id}: row ${i} out of order`)
          if (r.isRoot !== (r.source != null)) bad.push(`${seg.id}: _source on ${r.id} (${r.isRoot ? 'root' : 'child'})`)
          if (!r.isRoot) {
            // its root comes later, and no other block's row sits in between
            const j = sf.rows.findIndex((x, k) => k > i && x.id === r.root)
            if (j < 0) bad.push(`${seg.id}: child ${r.id} has no root after it`)
            else if (sf.rows.slice(i, j).some((x) => x.root !== r.root)) bad.push(`${seg.id}: block of ${r.root} not contiguous`)
          }
          if (sf.chunks[r.chunk]?.ords.includes(r.ord) !== true) bad.push(`${seg.id}: row ${i} not in its chunk`)
        })
        const all = sf.chunks.flatMap((ch) => ch.ords)
        if (all.length !== sf.maxDoc || all.some((o, i) => o !== i)) bad.push(`${seg.id}: chunks don't partition`)
        if (sf.chunks.some((ch) => ch.ords.length > FDT_CHUNK_MAX || ch.ords.length === 0)) bad.push(`${seg.id}: chunk size`)
      }
    check(`${name}: stored-field rows are by ordinal, root last per block, _source on roots only, chunks partition`,
      bad.length === 0, bad.slice(0, 5).join('; '))
  }
  {
    const nestedChildren = NESTED.shards.flatMap((s) => s.segments).flatMap((seg) =>
      buildStoredFields(seg, NESTED.docs).rows.filter((r) => !r.isRoot))
    check('catalog-nested: the stored-fields tile has child rows to show as "nothing stored"', nestedChildren.length > 0)
  }

  // 4. the fetch close-up: every winner of the coordinator's cut resolves to
  //    exactly one searchable segment of its shard, at the ordinal that holds it.
  for (const [name, c, query] of [['sample', SAMPLE, 'search'], ['catalog-nested', NESTED, NESTED_QUERIES[2]]]) {
    const search = searchOp.extra(c, { type: 'search', step: 4, payload: { query, routing: null } }).search
    const co = computeCoordinatorMerge(search)
    let bad = []
    for (const [sid, ws] of Object.entries(co.byShard)) {
      const shard = c.shards.find((s) => s.id === Number(sid))
      if (!search.serving[sid]) bad.push(`shard ${sid} not serving`)
      for (const w of ws) {
        const at = locateInShard(shard, w.docId)
        const holders = shard.segments.filter((seg) => seg.searchable && seg.docIds.includes(w.docId))
        if (!at || holders.length !== 1 || holders[0] !== at.seg || at.seg.docIds[at.ord] !== w.docId)
          bad.push(`${w.docId}: ${holders.length} holders, at=${at?.seg?.id}:${at?.ord}`)
        if (!c.docs[w.docId] || (c.docs[w.docId].kind ?? 'root') !== 'root') bad.push(`${w.docId}: winner is not a block root`)
      }
    }
    check(`${name} "${query}": ${co.winners.length} winners each resolve to one (segment, ordinal) on a serving shard`,
      co.winners.length > 0 && bad.length === 0, bad.join('; '))
  }
}

console.log()
if (failures) {
  console.log(`\x1b[31m${failures} check${failures === 1 ? '' : 's'} failed\x1b[0m`)
  process.exit(1)
}
console.log('\x1b[32mall checks passed\x1b[0m')
