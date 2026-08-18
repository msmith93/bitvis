// Assertions over the PURE models — the invariants SPEC.md states in prose and
// nothing has ever checked. Run with `npm run check`.
//
// There is no test runner in this repo on purpose (see CLAUDE.md): the
// deliverable is a screen-recordable app, verified by running it. But four
// things here are arithmetic, not appearance, and a browser cannot tell you they
// are wrong — it will happily animate a confident, incorrect number:
//
//   1. the two zoom levels agree on which terms a pattern matched
//   2. editDistance is really Damerau-Levenshtein, including its bounded form
//   3. BM25 produces the numbers the docs and scenario copy quote
//   4. the shard close-up scores identically to the cluster-level search
//
// Dependency-free and node-only. The app's imports are extensionless (Vite
// resolves them), so a small loader hook below does the same for node.

import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolvePath(HERE, '../src') + '/'

// --- extensionless-import resolver, so node can load the app's modules --------
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
const { initialCluster, docRoute } = await import(SRC + 'cluster.js')
const { SAMPLE_DOCS } = await import(SRC + 'presets.js')
const { buildTermIndex } = await import(SRC + 'blocktree.js')
const { compileAutomaton, intersectTrace } = await import(SRC + 'automaton.js')
const W = await import(SRC + 'wildcard.js')
const R = await import(SRC + 'relevance.js')
const S = await import(SRC + 'ops/search.js')

let failures = 0
const ok = (name) => console.log(`  [32m✓[0m ${name}`)
function check(name, cond, detail) {
  if (cond) return ok(name)
  failures += 1
  console.log(`  [31m✗ ${name}[0m${detail ? '\n      ' + detail : ''}`)
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps

// The cluster the app builds from "Load sample docs", rebuilt here so the checks
// run against the same data a reader sees.
function sampleCluster() {
  const c = initialCluster()
  const byShard = { 0: [], 1: [], 2: [] }
  SAMPLE_DOCS.forEach((d, i) => {
    const id = `doc-${i + 1}`
    const doc = {
      id,
      title: d.title,
      body: d.body,
      tokens: analyzeDoc(d),
      deleted: false,
      color: '#fff',
      routing: d.routing,
      shard: docRoute({ id, routing: d.routing }),
    }
    c.docs[id] = doc
    byShard[doc.shard].push(id)
  })
  let seg = 1
  for (const shard of c.shards) {
    const ids = byShard[shard.id]
    for (let j = 0; j < ids.length; j += 2)
      shard.segments.push({
        id: `seg-${seg++}`,
        docIds: ids.slice(j, j + 2),
        searchable: true,
        committed: true,
      })
  }
  return c
}

const runSearch = (cluster, payload) =>
  S.default.extra(cluster, { type: 'search', step: 0, payload }).search

// ---------------------------------------------------------------------------
console.log('\nedit distance — Damerau-Levenshtein, and its bounded form')
// ---------------------------------------------------------------------------
function referenceDamerau(a, b) {
  const m = []
  for (let i = 0; i <= a.length; i++) {
    m[i] = [i]
    for (let j = 1; j <= b.length; j++) m[i][j] = i === 0 ? j : 0
  }
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        m[i][j] = Math.min(m[i][j], m[i - 2][j - 2] + 1)
    }
  return m[a.length][b.length]
}

const words = ['', 'a', 'ab', 'the', 'hte', 'search', 'serch', 'store', 'score',
  'stores', 'scaling', 'elasticsearch', 'elasticsarch', 'abcd', 'badc']
let exact = 0
let bounded = 0
for (const a of words)
  for (const b of words) {
    const want = referenceDamerau(a, b)
    if (W.editDistance(a, b) !== want) exact += 1
    // The bounded form may return anything above `max`, but its VERDICT must match.
    for (const max of [0, 1, 2])
      if ((W.editDistance(a, b, max) <= max) !== (want <= max)) bounded += 1
  }
check(`unbounded matches a reference implementation (${words.length ** 2} pairs)`, exact === 0,
  `${exact} disagreements`)
check('bounded form gives the same within-max verdict', bounded === 0, `${bounded} disagreements`)
check('transposition costs one edit, not two', W.editDistance('hte', 'the') === 1)
check('AUTO fuzziness follows Elasticsearch AUTO:3,6',
  W.autoFuzziness('ab') === 0 && W.autoFuzziness('serch') === 1 && W.autoFuzziness('search') === 2)
check('edit distance is clamped to Lucene\'s supported maximum',
  W.parsePattern('search~5').maxEdits === W.MAX_EDITS)

// ---------------------------------------------------------------------------
console.log('\nthe two zoom levels agree on what a pattern matched')
// ---------------------------------------------------------------------------
// SPEC.md: "automaton.js's intersection is checked against expandTerms — so the
// levels can't drift apart." This is that check.
const allTerms = [
  ...new Set(SAMPLE_DOCS.flatMap((d) => { const t = analyzeDoc(d); return [...t.title, ...t.body] })),
].sort()
const segments = [allTerms, allTerms.filter((t) => t < 'm'), allTerms.slice(0, 12)]
const queries = ['search', 'data', 'sc*', 'search*', '*search', 's?a*', 'serch~', 'serch~1',
  'serch~2', 'store~1', 'search~2', 'elasticsarch~2', 'scaling~1', 'xyzzy~2']

let drift = 0
let capped = 0
let cases = 0
for (const q of queries)
  for (const prefixLength of [0, 1, 2, 3])
    for (const terms of segments) {
      const [pattern] = W.parseQuery(q, { prefixLength })
      if (!pattern) continue
      cases += 1
      const index = buildTermIndex(terms.map((t) => ({ term: t, docIds: ['d1'] })))
      const dfa = compileAutomaton(pattern, [...new Set(terms.flatMap((t) => [...t]))])
      if (dfa.capped) capped += 1
      const walked = intersectTrace(index, dfa).matched
      const flat = [...W.expandTerms(terms, [pattern])].sort()
      if (JSON.stringify(walked) !== JSON.stringify(flat)) {
        drift += 1
        console.log(`      ${q} prefix_length=${prefixLength}: walk ${JSON.stringify(walked)} vs flat ${JSON.stringify(flat)}`)
      }
    }
check(`intersectTrace matched === expandTerms (${cases} cases)`, drift === 0, `${drift} mismatches`)
check('no pattern hit maxDeterminizedStates at this scale', capped === 0)

// A fuzzy with no pinned prefix must be structurally unprunable, exactly like a
// leading wildcard — the claim the copy makes in three places.
const index = buildTermIndex(allTerms.map((t) => ({ term: t, docIds: ['d1'] })))
const alphabet = [...new Set(allTerms.flatMap((t) => [...t]))]
const dfaFor = (q, prefixLength) =>
  compileAutomaton(W.parseQuery(q, { prefixLength })[0], alphabet)
check('prefix_length 0 fuzzy accepts any first character (like a leading wildcard)',
  dfaFor('serch~1', 0).startAcceptsAnything === true &&
    dfaFor('*search', 0).startAcceptsAnything === true)
check('prefix_length 2 fuzzy does not', dfaFor('serch~1', 2).startAcceptsAnything === false)
const read0 = intersectTrace(index, dfaFor('serch~1', 0)).termsRead
const read2 = intersectTrace(index, dfaFor('serch~1', 2)).termsRead
check(`pinning the prefix cuts the dictionary read (${read0} → ${read2} terms)`, read2 < read0 / 2)

// ---------------------------------------------------------------------------
console.log('\nBM25')
// ---------------------------------------------------------------------------
check('k1 and b are Lucene\'s defaults', R.K1 === 1.2 && R.B === 0.75)
check('idf = ln(1 + (N - n + 0.5)/(n + 0.5))',
  near(R.idf(5, 4), Math.log(1 + 1.5 / 4.5)))
check('idf rises as a term gets rarer', R.idf(100, 1) > R.idf(100, 50))
check('idf is never negative even for a term in every document', R.idf(10, 10) >= 0)

// Hand-computed: doc-2 is tf=4, |D|=10, on shard 0 where N=5, n=4, avgdl=10.6.
{
  const norm = R.K1 * (1 - R.B + (R.B * 10) / 10.6)
  const want = R.idf(5, 4) * ((4 * (R.K1 + 1)) / (4 + norm))
  const cluster = sampleCluster()
  const search = runSearch(cluster, { query: 'search', routing: null, searchType: 'query_then_fetch' })
  const got = search.perShard[0].find((h) => h.docId === 'doc-2').score
  check(`doc-2 scores the hand-computed ${want.toFixed(3)}`, near(got, want, 1e-12),
    `model gave ${got}`)
}

// Saturation: doubling tf must add less than the first occurrence did.
{
  const stats = { docCount: 10, totalLength: 100, avgFieldLength: 10, docFreq: { x: 3 } }
  const mk = (n) => ({ tokens: { title: [], body: Array.from({ length: 10 }, (_, i) => (i < n ? 'x' : 'y')) } })
  const p = W.parseQuery('x')
  const s1 = R.scoreDoc(mk(1), p, stats).score
  const s2 = R.scoreDoc(mk(2), p, stats).score
  const s4 = R.scoreDoc(mk(4), p, stats).score
  check('term frequency saturates', s2 - s1 > s4 - s2 && s4 > s2)
}

// A shorter document with the same tf must outscore a longer one.
{
  const stats = { docCount: 10, totalLength: 100, avgFieldLength: 10, docFreq: { x: 3 } }
  const short = { tokens: { title: [], body: ['x', 'y'] } }
  const long = { tokens: { title: [], body: ['x', ...Array(19).fill('y')] } }
  check('the length norm rewards the shorter document',
    R.scoreDoc(short, W.parseQuery('x'), stats).score >
      R.scoreDoc(long, W.parseQuery('x'), stats).score)
}

// ---------------------------------------------------------------------------
console.log('\nper-shard vs global statistics')
// ---------------------------------------------------------------------------
{
  const cluster = sampleCluster()
  const local = runSearch(cluster, { query: 'search', routing: null, searchType: 'query_then_fetch' })
  const global = runSearch(cluster, { query: 'search', routing: null, searchType: 'dfs_query_then_fetch' })

  check('DFS sums docCounts across shards, without double counting',
    local.stats.global.docCount ===
      Object.values(local.stats.perShard).reduce((n, s) => n + s.docCount, 0) &&
      local.stats.global.docCount === SAMPLE_DOCS.length)
  check('every shard scores against the same collection under DFS',
    new Set([0, 1, 2].map((i) => S.statsForShard(global, i))).size === 1)
  check('each shard scores against its own collection otherwise',
    new Set([0, 1, 2].map((i) => S.statsForShard(local, i).docCount)).size > 1)

  // The re-ranking the scenario copy and the README both quote.
  check('per-shard stats put doc-3 first (the 4-document shard skews its idf)',
    local.merged[0].docId === 'doc-3', `got ${local.merged[0].docId}`)
  check('global stats put doc-2 first and drop doc-3 to fifth',
    global.merged[0].docId === 'doc-2' && global.merged[4].docId === 'doc-3',
    `got ${global.merged.slice(0, 5).map((m) => m.docId).join(', ')}`)

  // The contract in ops/search.js: the close-up must not disagree with the panel.
  for (const searchType of ['query_then_fetch', 'dfs_query_then_fetch']) {
    const s = runSearch(cluster, { query: 'search', routing: null, searchType })
    let bad = 0
    for (const shard of cluster.shards) {
      const localShard = S.computeShardSearch(shard, s.patterns, cluster.docs, 3,
        S.statsForShard(s, shard.id))
      for (const hit of s.perShard[shard.id]) {
        const mine = localShard.scored.find((x) => x.docId === hit.docId)
        if (!mine || !near(mine.score, hit.score, 1e-12)) bad += 1
      }
    }
    check(`computeShardSearch matches computeSearch (${searchType})`, bad === 0, `${bad} differ`)
  }

  // A shard ships its top-k, not everything it scored.
  check('a shard returns at most its local top-k',
    Object.values(local.perShard).every((hits) => hits.length <= 3))
}

// ---------------------------------------------------------------------------
console.log('\nSPEC guardrails that survived the change')
// ---------------------------------------------------------------------------
{
  const cluster = sampleCluster()
  // A buffered doc is not searchable until refresh creates its segment.
  cluster.docs['doc-99'] = {
    id: 'doc-99', title: 'search search search', body: 'search',
    tokens: analyzeDoc({ title: 'search search search', body: 'search' }),
    deleted: false, color: '#fff', shard: 0,
  }
  cluster.shards[0].buffer.push('doc-99')
  const s = runSearch(cluster, { query: 'search', routing: null, searchType: 'query_then_fetch' })
  check('a buffered document cannot be found, however well it would score',
    !s.merged.some((h) => h.docId === 'doc-99'))
  check('a buffered document does not affect anyone else\'s statistics',
    s.stats.perShard[0].docCount === 5)
}

console.log(
  failures
    ? `\n[31m${failures} check${failures === 1 ? '' : 's'} failed[0m\n`
    : '\n[32mall checks passed[0m\n',
)
process.exit(failures ? 1 : 0)
