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
const { routeShard } = await import(SRC + 'cluster.js')
const { SAMPLE_DOCS, FUZZY_QUERIES, WILDCARD_QUERIES } = await import(SRC + 'presets.js')
const { buildTermIndex } = await import(SRC + 'blocktree.js')
const { ANY, compileAutomaton, intersectTrace } = await import(SRC + 'automaton.js')
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

console.log()
if (failures) {
  console.log(`\x1b[31m${failures} check${failures === 1 ? '' : 's'} failed\x1b[0m`)
  process.exit(1)
}
console.log('\x1b[32mall checks passed\x1b[0m')
