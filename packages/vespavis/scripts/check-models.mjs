// Assertions over the PURE models — the invariants SPEC.md states in prose and
// nothing else checks. Run with `npm run check`.
//
// There is no test runner in this repo on purpose (see CLAUDE.md): the
// deliverable is a screen-recordable app, verified by running it. That is still
// right for everything the app DRAWS. But three things here are arithmetic or
// invariance, and a browser will animate a wrong number confidently:
//
//   1. the distribution algorithm really does place every document on exactly
//      `redundancy` nodes with exactly one active copy — the whole reason a
//      redundancy-2 cluster does not return everything twice;
//   2. flush and fusion change NOTHING a query can see. They are maintenance
//      jobs about memory and read cost, and the app says so — so it is checked
//      by running the same query either side of both and comparing;
//   3. the three retrieval modes disagree in the specific ways the demo
//      queries are chosen to show. If a corpus edit quietly makes hybrid agree
//      with BM25, the app still looks fine and teaches nothing.
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

const C = await import(SRC + 'cluster.js')
const S = await import(SRC + 'schema.js')
const R = await import(SRC + 'ranking.js')
const V = await import(SRC + 'vectors.js')
const OPS = await import(SRC + 'ops/index.js')
const V2 = await import(SRC + 'vectors.js')
const { REDUNDANCY, NUM_BUCKETS } = C
const { readFileSync, readdirSync, statSync } = await import('node:fs')
const CFG = S.DEFAULT_SCHEMA_CONFIG

let failures = 0
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`)
function check(name, cond, detail) {
  if (cond) return ok(name)
  failures += 1
  console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? '\n      ' + detail : ''}`)
}
const section = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`)

// Run an op all the way through and fold it in, exactly as the app's
// "fold before next" does.
function run(cluster, type, payload) {
  const op = { type, step: 0, payload }
  return OPS.applyOp(cluster, op)
}

const cluster0 = C.seedCluster(S.CORPUS, S.USERS)

// ---------------------------------------------------------------------------
section('1 · Distribution — buckets, ideal state, active copies')
// ---------------------------------------------------------------------------
{
  let everyDocPlaced = true
  let exactlyOneActive = true
  for (const d of Object.values(cluster0.docs)) {
    const reps = C.bucketReplicas(d.bucket)
    if (reps.length !== REDUNDANCY) everyDocPlaced = false
    const holders = cluster0.nodes.filter((n) => n.ready.includes(d.id))
    if (holders.length !== REDUNDANCY) everyDocPlaced = false
    const actives = cluster0.nodes.filter((n) =>
      C.activeReadyDocs(n, cluster0.docs, d.type).includes(d.id),
    )
    if (actives.length !== 1) exactlyOneActive = false
  }
  check(`every document is stored on exactly ${REDUNDANCY} nodes`, everyDocPlaced)
  check('every document is ACTIVE on exactly one node', exactlyOneActive)

  const totalActive = cluster0.nodes.reduce(
    (t, n) =>
      t +
      C.activeReadyDocs(n, cluster0.docs, 'product').length +
      C.activeReadyDocs(n, cluster0.docs, 'user').length,
    0,
  )
  check(
    'the active sets partition the corpus (no double counting)',
    totalActive === Object.keys(cluster0.docs).length,
    `${totalActive} active vs ${Object.keys(cluster0.docs).length} documents`,
  )
  // Document type is what separates the two schemas, not placement: a user
  // lives on the same nodes, in the same buckets, as the products around it.
  check(
    'user documents share the cluster but never appear in a product query',
    cluster0.nodes.every(
      (n) =>
        C.activeReadyDocs(n, cluster0.docs, 'product').every(
          (id) => cluster0.docs[id].type === 'product',
        ) && !n.diskIndexes.some((d) => d.docIds.some((id) => cluster0.docs[id].type === 'user')),
    ),
  )

  // The ideal state must not degenerate into fixed pairs of nodes. It did,
  // before hash32 grew a finalizer — see the comment there.
  const orders = new Set(
    Array.from({ length: NUM_BUCKETS }, (_, b) => C.bucketReplicas(b).join(',')),
  )
  check(
    'the ideal state produces more than two distinct placements',
    orders.size > 2,
    `only ${orders.size}: ${[...orders].join(' | ')}`,
  )

  // Elasticity. This is the property CRUSH-style placement exists for and the
  // one a hand-rolled hash gets wrong: when a node leaves, the ranking of the
  // REMAINING nodes for every bucket must be unchanged, so the only data that
  // moves is the data that lived on the node that left. Recomputed here over a
  // 3-node cluster rather than filtered out of the 4-node answer, or the check
  // would be comparing a list to itself.
  const rankOver = (nodeIds, bucket) =>
    nodeIds
      .map((id) => ({ id, draw: C.hash32(`${bucket}:${id}`) }))
      .sort((a, b) => b.draw - a.draw || a.id - b.id)
      .map((s) => s.id)

  const all = C.CONTENT_NODES.map((n) => n.id)
  const gone = 3
  const survivors = all.filter((n) => n !== gone)
  const stable = Array.from({ length: NUM_BUCKETS }, (_, b) => b).every(
    (b) =>
      rankOver(all, b).filter((n) => n !== gone).join(',') ===
      rankOver(survivors, b).join(','),
  )
  check(
    'losing a node leaves every other node\'s ranking for every bucket unchanged',
    stable,
  )
}

// ---------------------------------------------------------------------------
section('2 · The write path — real-time by construction')
// ---------------------------------------------------------------------------
let afterFeed
{
  const doc = S.makeDoc(S.NEW_DOCS[0], 99)
  afterFeed = run(cluster0, 'feed', { doc })
  const reps = C.bucketReplicas(C.bucketOf(doc.id))
  const holders = afterFeed.nodes.filter((n) => n.ready.includes(doc.id))
  check(
    'a fed document lands on every replica of its bucket',
    holders.length === REDUNDANCY &&
      holders.every((n) => reps.includes(n.id)),
  )
  check(
    'and in the MEMORY index on each of them',
    holders.every((n) => n.memoryIndex.includes(doc.id)),
  )
  check(
    'and in the transaction log on each of them',
    holders.every((n) => n.translog.some((t) => t.id === doc.id)),
  )

  // THE headline invariant: no flush has run, and it is already findable.
  const q = R.runQuery(afterFeed, { mode: 'lexical', text: 'three layer rain jacket' })
  check(
    'it is queryable immediately, with no flush or commit in between',
    q.final.some((h) => h.id === doc.id),
    'the newly fed document did not come back from a query',
  )
}

// ---------------------------------------------------------------------------
section('3 · Flush and fusion change nothing a query can see')
// ---------------------------------------------------------------------------
{
  const q = (cl) =>
    JSON.stringify(
      R.runQuery(cl, { mode: 'hybrid', text: 'waterproof jacket' }).final.map((h) => [
        h.id,
        h.score,
      ]),
    )

  const beforeFlush = q(afterFeed)
  const flushed = run(afterFeed, 'flush', { newIndexes: {} })
  check('flush empties every memory index', flushed.nodes.every((n) => !n.memoryIndex.length))
  check(
    'flush prunes the transaction log',
    flushed.nodes.every((n) => n.translog.length === 0),
  )
  check('flush leaves the Ready sub-database alone', 
    flushed.nodes.every((n, i) => n.ready.length === afterFeed.nodes[i].ready.length))
  check(
    'the same query returns the same hits, in the same order, with the same scores',
    q(flushed) === beforeFlush,
    'flush changed the result set — it must not',
  )

  const fused = run(flushed, 'fusion', { newIndexes: {} })
  check('fusion leaves exactly one disk index per node', 
    fused.nodes.every((n) => n.diskIndexes.length === 1))
  check(
    'and the query result is STILL identical',
    q(fused) === beforeFlush,
    'fusion changed the result set — it must not',
  )
}

// ---------------------------------------------------------------------------
section('4 · Partial update — in place, no index work')
// ---------------------------------------------------------------------------
{
  const id = S.CORPUS[6].id // City Sneaker
  const before = cluster0.docs[id].popularity
  const after = run(cluster0, 'update', {
    id,
    docType: 'product',
    field: 'popularity',
    kind: 'attribute',
    from: before,
    value: 0.99,
  })
  check('the attribute value is assigned', after.docs[id].popularity === 0.99)
  check(
    'no posting list moved: memory indexes are untouched',
    after.nodes.every((n, i) => 
      JSON.stringify(n.memoryIndex) === JSON.stringify(cluster0.nodes[i].memoryIndex)),
  )
  check(
    'and no disk index was rewritten',
    after.nodes.every((n, i) =>
      JSON.stringify(n.diskIndexes) === JSON.stringify(cluster0.nodes[i].diskIndexes)),
  )
  check(
    'the durability log still records it',
    C.bucketReplicas(C.bucketOf(id)).every((nid) =>
      after.nodes.find((n) => n.id === nid).translog.some((t) => t.kind === 'update'),
    ),
  )
  // And it counts immediately, because ranking reads the column directly.
  const q = R.runQuery(after, { mode: 'hybrid', text: 'city sneaker' })
  const hit = q.merged.find((h) => h.id === id)
  check('ranking sees the new value on the very next query', hit?.popularity === 0.99)

  // The other half of the comparison. Same request shape, same op, different
  // field — and now the cluster is moving postings.
  const idx = run(cluster0, 'update', {
    id,
    docType: 'product',
    field: 'title',
    kind: 'index',
    from: cluster0.docs[id].title,
    value: 'City Sneaker Pro',
  })
  check(
    'the same update to an INDEX field writes a new memory-index entry',
    idx.nodes.some((n, i) => n.memoryIndex.length > cluster0.nodes[i].memoryIndex.length),
  )
  check(
    'and the footer says so: the index path has more steps than the attribute path',
    OPS.stepsOf({ type: 'update', step: 0, payload: { kind: 'index' } }).length >
      OPS.stepsOf({ type: 'update', step: 0, payload: { kind: 'attribute' } }).length,
  )
}

// ---------------------------------------------------------------------------
section('4b · Recommendation — a user tensor, moved in place')
// ---------------------------------------------------------------------------
{
  const alice = S.USERS[0]
  const rec = (cl) =>
    R.runQuery(cl, {
      mode: 'recommend',
      userProfile: cl.docs[alice.id].profile,
      userName: alice.user_id,
    })

  check(
    'the user profile field declares no HNSW index',
    !/field profile[\s\S]*?index\s*\{/.test(S.USER_SCHEMA) &&
      /field profile type tensor<float>\(x\[2\]\) \{\s*\n\s*indexing: summary \| attribute/.test(
        S.USER_SCHEMA,
      ),
    'nothing ANN-searches users, so a profile must be a plain attribute',
  )

  const before = rec(cluster0)
  check(
    'a recommendation ranks products by closeness to the profile tensor',
    before.final.every(
      (h, i) => i === 0 || h.closeness <= before.final[i - 1].closeness + 1e-9,
    ),
    before.final.map((h) => `${cluster0.docs[h.id].title} ${h.closeness}`).join(' | '),
  )
  check(
    'and no text was involved at any point',
    before.terms.length === 0 && before.queryVector === cluster0.docs[alice.id].profile,
  )

  // Engage with an outerwear product; the profile should move toward it.
  const jacket = S.CORPUS[0]
  const moved = run(cluster0, 'update', {
    id: alice.id,
    docType: 'user',
    userName: alice.user_id,
    field: 'profile',
    kind: 'attribute',
    from: alice.profile,
    value: S.nudgeProfile(alice.profile, jacket.embedding),
  })
  const dBefore = V2.angularDistance(alice.profile, jacket.embedding)
  const dAfter = V2.angularDistance(moved.docs[alice.id].profile, jacket.embedding)
  check('engaging moves the profile toward what was engaged with', dAfter < dBefore)
  check(
    'and nothing else moved: every index and every disk index is untouched',
    moved.nodes.every(
      (n, i) =>
        JSON.stringify(n.memoryIndex) === JSON.stringify(cluster0.nodes[i].memoryIndex) &&
        JSON.stringify(n.diskIndexes) === JSON.stringify(cluster0.nodes[i].diskIndexes),
    ),
  )

  const after = rec(moved)
  const outerBefore = before.final.filter(
    (h) => cluster0.docs[h.id].category === 'outerwear',
  ).length
  const outerAfter = after.final.filter((h) => moved.docs[h.id].category === 'outerwear').length
  check(
    'so the next recommendation returns more of what was engaged with',
    outerAfter > outerBefore,
    `outerwear in top ${before.final.length}: ${outerBefore} → ${outerAfter}`,
  )
}

// ---------------------------------------------------------------------------
section('4c · One line of schema decides pre-filter or post-filter')
// ---------------------------------------------------------------------------
{
  const q = (fastSearch) =>
    R.runQuery(
      cluster0,
      { mode: 'filtered', text: 'waterproof jacket', category: 'outerwear' },
      { ...CFG, categoryFastSearch: fastSearch },
    )

  const pre = q(true)
  const post = q(false)
  check(
    'with fast-search, documents are excluded BEFORE the walk and nothing is wasted',
    pre.preFilter && pre.totalFilteredOut > 0 && pre.totalPostFilterDropped === 0,
  )
  check(
    'without it, the walk runs unrestricted and its hits are thrown away after',
    post.postFilter && post.totalPostFilterDropped > 0 && post.totalFilteredOut === 0,
  )
  check(
    'either way every hit returned still matches the filter',
    [...pre.final, ...post.final].every(
      (h) => cluster0.docs[h.id].category === 'outerwear',
    ),
  )
}

// ---------------------------------------------------------------------------
section('4d · The schema config really drives the model')
// ---------------------------------------------------------------------------
{
  const at = (over) =>
    R.runQuery(cluster0, { mode: 'hybrid', text: 'waterproof jacket' }, { ...CFG, ...over })

  const lexOff = at({ lexicalWeight: 0 })
  const lexHigh = at({ lexicalWeight: 1 })
  const speaker = S.CORPUS[7].id
  const rank = (r) => r.merged.findIndex((h) => h.id === speaker)
  check(
    'raising the first-phase lexical weight promotes the lexical-only match',
    rank(lexHigh) < rank(lexOff),
    `speaker merged rank: weight 0 → ${rank(lexOff)}, weight 1 → ${rank(lexHigh)}`,
  )
  check(
    'targetHits changes how many neighbours each node exposes',
    Object.values(at({ targetHits: 1 }).perNode).every((p) => p.annMatches <= 1) &&
      Object.values(at({ targetHits: 6 }).perNode).some((p) => p.annMatches > 1),
  )
  check(
    'second-phase rerank-count changes how many each node re-scores',
    Object.values(at({ secondPhaseRerankCount: 1 }).perNode).every((p) => p.reranked <= 1),
  )
  check(
    'global-phase rerank-count changes how many the container model sees',
    at({ globalPhaseRerankCount: 2 }).globalReranked <= 2,
  )
}

// ---------------------------------------------------------------------------
section('5 · Remove — tombstone now, space later')
// ---------------------------------------------------------------------------
{
  const id = S.CORPUS[0].id // Storm Shell Jacket
  const removed = run(cluster0, 'remove', { id })
  check('it leaves the Ready sub-database', removed.nodes.every((n) => !n.ready.includes(id)))
  check(
    'a tombstone is written on every replica',
    C.bucketReplicas(C.bucketOf(id)).every((nid) =>
      removed.nodes.find((n) => n.id === nid).removed.some((r) => r.id === id),
    ),
  )
  check(
    'it cannot match any more',
    !R.runQuery(removed, { mode: 'lexical', text: 'waterproof jacket' }).merged.some(
      (h) => h.id === id,
    ),
  )
  check(
    'its entries are STILL in the disk indexes — nothing was rewritten',
    removed.nodes.some((n) => n.diskIndexes.some((d) => d.docIds.includes(id))),
  )
  const fused = run(removed, 'fusion', { newIndexes: {} })
  check(
    'fusion is what finally drops them',
    fused.nodes.every((n) => n.diskIndexes.every((d) => !d.docIds.includes(id))),
  )
}

// ---------------------------------------------------------------------------
section('6 · Ranking features')
// ---------------------------------------------------------------------------
{
  const d = 0.37
  check(
    'closeness(distance) = 1 / (1 + distance)',
    Math.abs(V.closeness(d) - 1 / (1 + d)) < 1e-12,
  )
  check(
    'angular distance is 0 for identical directions and 2 for opposite ones',
    Math.abs(V.angularDistance([1, 0], [1, 0])) < 1e-12 &&
      Math.abs(V.angularDistance([1, 0], [-1, 0]) - 2) < 1e-12,
  )

  // BM25 statistics are per content node, which is real Vespa behaviour and
  // easy to accidentally "fix" into a cluster-wide number.
  const q = R.runQuery(cluster0, { mode: 'lexical', text: 'waterproof' })
  const scores = new Map()
  for (const p of Object.values(q.perNode))
    for (const h of p.scored) {
      if (!scores.has(h.id)) scores.set(h.id, new Set())
      scores.get(h.id).add(h.bm25)
    }
  check(
    'bm25 uses node-local statistics (the app does not average them away)',
    [...scores.values()].every((s) => s.size >= 1),
  )

  // nearestNeighbor exposes at most targetHits per node, not per cluster.
  const ann = R.runQuery(cluster0, { mode: 'semantic', text: 'keep me dry in the rain' })
  check(
    `nearestNeighbor returns at most targetHits (${CFG.targetHits}) per content node`,
    Object.values(ann.perNode).every((p) => p.annMatches <= CFG.targetHits),
  )
}

// ---------------------------------------------------------------------------
section('7 · The three modes disagree, in the ways the demo depends on')
// ---------------------------------------------------------------------------
{
  const byTitle = (r, n = 99) =>
    r.final.slice(0, n).map((h) => cluster0.docs[h.id].title)

  const lex = R.runQuery(cluster0, { mode: 'lexical', text: 'waterproof jacket' })
  const sem = R.runQuery(cluster0, {
    mode: 'semantic',
    text: 'something to keep me dry in the rain',
  })
  const hyb = R.runQuery(cluster0, { mode: 'hybrid', text: 'waterproof jacket' })

  const L = byTitle(lex)
  const S1 = byTitle(sem)
  const H = byTitle(hyb)

  check(
    'BM25 alone puts a bluetooth speaker in the top 2 for "waterproof jacket"',
    L.slice(0, 2).includes('Waterproof Bluetooth Speaker'),
    L.join(' | '),
  )
  check(
    'BM25 alone never finds the windbreaker (it shares no query term)',
    !L.includes('Rain Shell Windbreaker'),
    L.join(' | '),
  )
  check(
    'the vector search finds it first, from a query with no overlapping words',
    S1[0] === 'Rain Shell Windbreaker',
    S1.join(' | '),
  )
  check(
    'the vector search alone never surfaces the speaker',
    !S1.includes('Waterproof Bluetooth Speaker'),
    S1.join(' | '),
  )
  check(
    'hybrid puts the actual jacket first',
    H[0] === 'Storm Shell Jacket',
    H.join(' | '),
  )
  check(
    'hybrid recovers the windbreaker into the top 3',
    H.slice(0, 3).includes('Rain Shell Windbreaker'),
    H.join(' | '),
  )
  check(
    'and demotes the speaker below it',
    H.indexOf('Waterproof Bluetooth Speaker') > H.indexOf('Rain Shell Windbreaker'),
    H.join(' | '),
  )

  // The filter is a PRE-filter: nothing outside the category can come back,
  // however close its vector is.
  const filt = R.runQuery(cluster0, {
    mode: 'filtered',
    text: 'waterproof jacket',
    category: 'outerwear',
  })
  check(
    'a filtered vector query returns only documents that pass the filter',
    filt.final.every((h) => cluster0.docs[h.id].category === 'outerwear'),
  )
  check(
    'and the filter really ran first — documents were excluded before the walk',
    Object.values(filt.perNode).reduce((t, p) => t + p.filteredOut, 0) > 0,
  )
}

// ---------------------------------------------------------------------------
section('8 · The step list is a property of the rank profile')
// ---------------------------------------------------------------------------
{
  const keys = (mode) =>
    OPS.stepsOf({ type: 'query', step: 0, payload: { mode } }).map((s) => s.key)
  check('a profile with no second-phase gets no second-phase step',
    !keys('lexical').includes('second'))
  check('a profile with no global-phase gets no global-phase step',
    !keys('semantic').includes('global'))
  check('the hybrid profile gets both',
    keys('hybrid').includes('second') && keys('hybrid').includes('global'))
  check(
    'a recommendation gets an extra step in front, to fetch the user document',
    keys('recommend')[0] === 'fetchUser' && !keys('hybrid').includes('fetchUser'),
  )
  check(
    'every profile still ends in the summary fill',
    ['lexical', 'semantic', 'hybrid', 'filtered', 'recommend'].every(
      (m) => keys(m).at(-1) === 'fill',
    ),
  )
  // A phase that is not in this profile's step list must never report as
  // reached — however far through the query we are. Getting this wrong lit the
  // container's global-phase slot, reading "rerank 0", on a semantic query's
  // last step: a claim that the phase ran and found nothing to do.
  const neverClaimsMissingPhases = ['lexical', 'semantic', 'filtered'].every((mode) => {
    const steps = OPS.stepsOf({ type: 'query', step: 0, payload: { mode } })
    return steps.every((_, i) => {
      const { at } = OPS.opExtra(cluster0, {
        type: 'query',
        step: i,
        payload: { mode, text: 'waterproof jacket', category: 'outerwear' },
      })
      return !at.global && !at.second
    })
  })
  check(
    'a phase the profile does not declare never reports as reached',
    neverClaimsMissingPhases,
  )

  // second-phase reranks the local top-k and no more.
  const hyb = R.runQuery(cluster0, { mode: 'hybrid', text: 'waterproof jacket' })
  check(
    `second-phase reranked at most ${CFG.secondPhaseRerankCount} per node`,
    Object.values(hyb.perNode).every((p) => p.reranked <= CFG.secondPhaseRerankCount),
  )
}

// ---------------------------------------------------------------------------
section('9 · Vespa is taught on its own terms')
// ---------------------------------------------------------------------------
{
  // Not style policing. v1 of this app explained Vespa by contrast with a
  // segment-based engine — "there is no refresh", "unlike Elasticsearch" — and
  // every one of those sentences is worthless to a reader who has not used the
  // other system, while quietly steering the whole design toward the wrong
  // subject. The contrast was removed deliberately; this keeps it removed.
  // This file states the rule, so it necessarily contains the words the rule
  // bans. It is the one exemption, and the only one.
  const SELF = 'check-models.mjs'
  const BANNED = /elasticsearch|lucene|opensearch|solr/i
  const roots = ['../src', '../scripts', '..']
  const offenders = []
  const walk = (dir, depth = 0) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist' || name === 'docs' || name.startsWith('.'))
        continue
      const full = `${dir}/${name}`
      const st = statSync(full)
      if (st.isDirectory()) {
        if (depth < 3) walk(full, depth + 1)
      } else if (name !== SELF && /\.(js|jsx|mjs|css|html|md)$/.test(name)) {
        const text = readFileSync(full, 'utf8')
        if (BANNED.test(text)) offenders.push(full.replace(/.*\/vespavis\//, ''))
      }
    }
  }
  walk(resolvePath(HERE, '../src'))
  walk(resolvePath(HERE, '../scripts'))
  for (const f of ['README.md', 'SPEC.md', 'CLAUDE.md', 'PLAN.md', 'index.html']) {
    try {
      const full = resolvePath(HERE, '..', f)
      if (BANNED.test(readFileSync(full, 'utf8'))) offenders.push(f)
    } catch {}
  }
  check(
    'no source file or doc explains Vespa by comparison with another engine',
    offenders.length === 0,
    offenders.length ? `found in: ${[...new Set(offenders)].join(', ')}` : '',
  )
}

console.log(
  failures
    ? `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`
    : '\n\x1b[32mAll checks passed\x1b[0m\n',
)
process.exit(failures ? 1 : 0)
