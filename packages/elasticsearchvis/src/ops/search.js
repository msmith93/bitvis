import { docRootId, routeShard, selectServingCopy } from '../cluster'
import { MAX_GATHER_IDS, SEARCH_SIZE } from '../constants'
import { docFieldLen, docFreqOf, mergeStats, segmentInvertedIndex, shardStats } from '../invertedIndex'
import { idf, termScore } from '../similarity'
import { FETCH_REQUEST_MS, flightMs, FLIGHT_PAD_MS } from '../timing'
import {
  clauseCoversField,
  dictionaryScan,
  isConjunctive,
  isPatternQuery,
  matchesAny,
  matchTerm,
  parseQuery,
  patternLabel,
} from '../wildcard'

// The `search` op: two-phase query-then-fetch scatter-gather. Read-only — it
// has no derive(), so applyOp leaves the committed cluster untouched.
//
// Two payload options change WHERE and HOW MUCH work happens:
//   payload.routing — hash the routing key instead of scattering: exactly one
//                     shard is queried, the other two do nothing.
//   a `*` or `~` in the query — the term is a PATTERN (wildcard or fuzzy) that
//                     must first be expanded against each segment's term
//                     dictionary.

// dfs_query_then_fetch's extra phase. A whole round trip to every shard,
// carrying NUMBERS rather than documents — which is the cost that keeps it off
// by default.
//
// It sits AFTER the coordinator has the query and BEFORE the scatter, and it
// cannot sit anywhere else: what it asks for is the document frequency of THIS
// query's terms, so there is nothing to ask about until the query has arrived.
const DFS_STEP = {
  key: 'dfs',
  ms: 1600, // overridden by duration() (statistics flights)
  title: '2 · Gather global term statistics',
  blurb:
    'The coordinator has the terms, so before asking anyone to search it asks every shard what those terms are worth: their document frequencies, summed into one set of numbers. Every shard then scores on the SAME statistics — at the cost of a round trip to all of them.',
}

const STEPS = [
  {
    key: 'coordinator',
    ms: 1400, // overridden by duration() (query flight)
    title: '1 · Coordinator receives the query',
    blurb:
      'The client sends a search to the coordinator (Node 1). The query string is analyzed into terms using the same analyzer used at index time.',
  },
  {
    key: 'scatter',
    ms: 1400, // overridden by duration() (fan-out flights)
    title: '2 · Scatter (query phase)',
    blurb:
      'The coordinator fans the query out to ONE copy of every shard — primary or replica — spread across the nodes. This is why a search runs on all nodes. A routing key is the exception: it names the one shard that can hold the data.',
  },
  {
    key: 'local',
    ms: 1600,
    title: '3 · Each shard searches locally',
    blurb:
      'Each contacted shard searches its own segments’ inverted indexes, scores the matching docs with BM25 using its OWN term statistics, and returns only its local top hits — doc ids + scores, not the full documents.',
  },
  {
    key: 'gather',
    ms: 1600, // overridden by duration() (hit-id flights)
    title: '4 · Gather + merge + sort',
    blurb:
      'The coordinator gathers every shard’s local hits, merges them, and sorts by score to produce the global ranking. Each shard scored with its own statistics, so this ranking compares numbers that were not measured on the same scale.',
  },
  {
    key: 'fetch',
    ms: 1600, // overridden by duration() (request + document flights)
    title: '5 · Fetch phase',
    blurb:
      'For the winning doc ids, the coordinator sends a GET _source request to each shard holding one, and gets the full document back. This two-phase query-then-fetch avoids shipping full documents for non-matching hits.',
  },
  {
    key: 'return',
    ms: 1300,
    title: '6 · Return to the client',
    blurb:
      'The coordinator returns the merged, ranked results to the client. Buffered (un-refreshed) and tombstoned documents never appear.',
  },
]

// Match one LUCENE doc against the query patterns: which terms hit it, and how
// often each occurs. `perTerm` is keyed by the real term, not the pattern, so a
// wildcard shows which terms it actually hit.
//
// Deliberately carries NO score: matching needs no statistics, scoring does.
// Splitting them keeps ONE matching path for the whole app — the postings tile
// pins `perTerm` against its own frequencies, and the object-vs-nested lesson
// only ever asks "did this match", never "how much is it worth".
//
// Two refinements, both inert unless the query uses them:
//   a field-qualified clause only counts terms from THAT field;
//   a conjunctive query matches nothing unless EVERY clause hit this one doc.
//
// That second rule is the entire object-vs-nested lesson, and it is deliberately
// one function for both: under `object` the whole document is one Lucene doc, so
// clauses agree across sub-objects that were never together; under `nested` each
// child is its own Lucene doc, so they have to agree within one child.
export function matchDoc(doc, patterns) {
  const perTerm = {}
  const clausesHit = new Set()
  for (const [field, terms] of Object.entries(doc.tokens))
    for (const term of terms) {
      let matched = false
      patterns.forEach((p, i) => {
        if (clauseCoversField(p, field) && matchTerm(term, p)) {
          matched = true
          clausesHit.add(i)
        }
      })
      // Counted once per TERM, not once per matching clause — the same frequency
      // the posting list carries.
      if (matched) perTerm[term] = (perTerm[term] || 0) + 1
    }
  // WHICH clauses this doc satisfied, always reported. A conjunctive query that
  // finds nothing is the most interesting outcome this app has, and without this
  // the candidates simply vanish between one step and the next with no account
  // of why — which is exactly the question the picture exists to answer.
  const clauses = patterns.map((p, i) => ({
    label: p.field ? `${p.field}:${p.raw}` : p.raw,
    hit: clausesHit.has(i),
  }))
  if (isConjunctive(patterns) && clausesHit.size < patterns.length)
    return { perTerm: {}, clauses, eliminated: true, matched: false }
  return { perTerm, clauses, eliminated: false, matched: Object.keys(perTerm).length > 0 }
}

// Score one LUCENE doc with BM25, using the statistics of the SHARD that holds
// it. Every matched term is one TermQuery and the query is their OR, so the
// contributions add up.
//
// `stats` is the shard's — not one segment's, and not the cluster's. That is
// exactly what query_then_fetch means: a shard scores with what it can see, so
// the same document can be worth different amounts on different shards. The
// `stats` step of the shard close-up is where that becomes visible.
//
// `terms` is the explain row per matched term — the numbers that produced the
// score, in the order the reader needs them: how often, how rare, how long.
export function scoreDoc(doc, patterns, stats) {
  const m = matchDoc(doc, patterns)
  const fieldLen = docFieldLen(doc)
  const terms = Object.entries(m.perTerm).map(([term, freq]) => {
    const docFreq = docFreqOf(stats, term)
    // docFreq 0 means this shard has never seen the term, so it contributes
    // nothing. Handing 0 to idf() would instead call it infinitely rare.
    const args = { freq, docFreq, docCount: stats.docCount, fieldLen, avgFieldLen: stats.avgFieldLen }
    return {
      term,
      freq,
      docFreq,
      fieldLen,
      idf: docFreq ? idf(docFreq, stats.docCount) : 0,
      contribution: docFreq ? termScore(args) : 0,
    }
  })
  return { ...m, score: terms.reduce((n, t) => n + t.contribution, 0), terms }
}

// The block join: fold per-Lucene-doc scores up to the Elasticsearch documents
// that own them. A flat doc is its own root, so this is the identity for every
// dataset that has no nested field.
//
// Scores SUM across a block. Elasticsearch's nested query defaults to
// `score_mode: avg`; summing is the choice that leaves a one-doc block's score
// exactly what it was, which is what keeps the existing scenarios intact.
// The term frequencies of one root, unioned over its whole block. For a flat doc
// this is just that doc's own perTerm.
function mergePerTerm(luceneScored, docs, rootId) {
  const out = {}
  for (const h of luceneScored) {
    if (!h.matched || docRootId(docs[h.docId]) !== rootId) continue
    for (const [term, n] of Object.entries(h.perTerm)) out[term] = (out[term] || 0) + n
  }
  return out
}

// The explain rows of one root, unioned over its whole block — the same roll-up
// `mergePerTerm` does, carried on the numbers that produced the score. idf and
// docFreq are properties of the TERM, so they are shared by every doc in the
// block; freq and contribution add up. fieldLen belongs to one Lucene doc, so it
// is only meaningful when exactly one of them contributed — which is every hit
// on flat data, and none on a block that matched in several children.
function mergeTerms(luceneScored, docs, rootId) {
  const out = new Map()
  for (const h of luceneScored) {
    if (!h.matched || docRootId(docs[h.docId]) !== rootId) continue
    for (const t of h.terms) {
      const e = out.get(t.term)
      if (!e) out.set(t.term, { ...t, from: 1 })
      else
        out.set(t.term, {
          ...e,
          freq: e.freq + t.freq,
          contribution: e.contribution + t.contribution,
          fieldLen: null,
          from: e.from + 1,
        })
    }
  }
  return [...out.values()].sort((a, b) => b.contribution - a.contribution)
}

function joinToRoots(luceneHits, docs) {
  const byRoot = new Map()
  for (const { docId, score, matched } of luceneHits) {
    if (!matched) continue
    const root = docRootId(docs[docId])
    const rootDoc = docs[root]
    if (!rootDoc || rootDoc.purged) continue
    byRoot.set(root, (byRoot.get(root) || 0) + score)
  }
  return [...byRoot].map(([docId, score]) => ({ docId, score }))
}

// What resolving this query costs in the term dictionaries it has to touch:
// every searched shard × every searchable segment. The multiplication is the
// point — a leading wildcard pays the full dictionary price once per segment.
function dictionaryCost(shards, docs, patterns) {
  let examined = 0
  let total = 0
  let segments = 0
  for (const shard of shards)
    for (const seg of shard.segments) {
      if (!seg.searchable) continue
      // Terms physically on disk — a purged delete's entries are still read
      // until a merge — so this matches the shard close-up's dictionary count.
      const scan = dictionaryScan(
        segmentInvertedIndex(seg, docs, { includePurged: true }).map((r) => r.term),
        patterns,
      )
      examined += scan.examined
      total += scan.total
      segments += 1
    }
  return { examined, total, segments, shards: shards.length }
}

// Run the (read-only) search against the committed cluster.
function computeSearch(cluster, op) {
  const patterns = parseQuery(op.payload.query)
  const routing = op.payload.routing || null
  // search_type. Off is query_then_fetch: every shard scores with what it alone
  // can see. On is dfs_query_then_fetch: one extra round trip first, so they all
  // score with the same numbers.
  const dfs = !!op.payload.dfs
  // The result window, exactly as a real query carries it. Elasticsearch sizes
  // each shard's priority queue at `from + size` AND cuts the merged list to the
  // same window, so this one number drives both ends of query-then-fetch.
  const from = op.payload.from ?? 0
  const size = op.payload.size ?? SEARCH_SIZE
  const window = from + size
  // A routing key hashes to exactly one shard — the only shard that can hold a
  // doc indexed with that key, so it is the only shard worth asking.
  const routedShard = routing ? routeShard(routing) : null
  const queried =
    routedShard == null
      ? cluster.shards
      : cluster.shards.filter((s) => s.id === routedShard)

  const serving = {} // shardId -> { node, role }   (queried shards only)
  // Each queried shard's OWN term statistics, summed out of its segments. One
  // per shard, never shared — which is the whole of query_then_fetch.
  const shardOwn = {} // shardId -> shardStats(...)
  // What each shard actually SCORES with. Identical to its own, unless this is a
  // dfs_query_then_fetch: then the coordinator has already collected every
  // shard's statistics and summed them, and hands the same totals to all of
  // them. That is the entire difference between the two search types — the same
  // roll-up function, one level up.
  const stats = {} // shardId -> the stats used to score
  const perShard = {} // shardId -> [{ docId, score }]  every local match
  const returned = {} // shardId -> [{ docId, score }]  the top `window` it SENDS
  // What the query actually had to look at: Lucene docs, against the
  // Elasticsearch documents they add up to. Identical on a flat dataset; on a
  // nested one the first number is the multiplier, and it is paid on every query.
  let luceneScanned = 0
  let rootsScanned = 0

  for (const shard of queried) {
    serving[shard.id] = selectServingCopy(shard)
    shardOwn[shard.id] = shardStats(shard, cluster.docs)
  }
  // The dfs pre-phase: sum first, then score. Note it sums the QUERIED shards —
  // a routed search asks only one, so its "global" view is that shard's own.
  const globalStats = mergeStats(Object.values(shardOwn))
  for (const shard of queried) stats[shard.id] = dfs ? globalStats : shardOwn[shard.id]

  for (const shard of queried) {

    const docIds = new Set()
    for (const seg of shard.segments)
      if (seg.searchable) for (const id of seg.docIds) docIds.add(id)
    for (const id of docIds) {
      const d = cluster.docs[id]
      if (!d || d.purged) continue
      luceneScanned += 1
      if (docRootId(d) === id) rootsScanned += 1
    }

    const luceneHits = []
    for (const id of docIds) {
      const doc = cluster.docs[id]
      // Tombstoned-but-not-yet-refreshed docs are still searchable (purged is
      // set by a refresh); only purged docs drop out of results.
      if (!doc || doc.purged) continue
      const { score, matched } = scoreDoc(doc, patterns, stats[shard.id])
      if (matched) luceneHits.push({ docId: id, score, matched })
    }
    // Matches are on LUCENE docs; the client asked about Elasticsearch
    // documents, so every hit is joined up to the root of its block.
    const hits = joinToRoots(luceneHits, cluster.docs)
    hits.sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))
    perShard[shard.id] = hits
    // A shard answers with its local top `from + size` and nothing else — the
    // rest never leaves it. `perShard` is kept whole because the stage still
    // highlights every matching doc, and the shard close-up's eviction demo is
    // only a lesson if the losers are visibly matches.
    returned[shard.id] = hits.slice(0, window)
  }

  // The coordinator only ever sees what the shards sent: at most
  // numShards * (from + size) candidates, however many actually matched.
  const merged = Object.entries(returned)
    .flatMap(([sid, hits]) => hits.map((h) => ({ ...h, shard: Number(sid) })))
    .sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))

  // `hits.total` is every matching document, summed across shards — NOT the size
  // of the returned window. (`track_total_hits` is not modelled: at this scale
  // the count is always exact, so a cap would be a control that never fires.)
  const totalHits = Object.values(perShard).reduce((n, hits) => n + hits.length, 0)

  return {
    terms: patterns.map((p) => p.raw), // display strings (patterns kept verbatim)
    patterns,
    wildcard: isPatternQuery(patterns),
    fuzzy: patterns.some((p) => p.kind === 'fuzzy'),
    routing,
    routedShard,
    skipped: cluster.shards.filter((s) => !(s.id in serving)).map((s) => s.id),
    conjunctive: isConjunctive(patterns),
    luceneScanned,
    rootsScanned,
    cost: dictionaryCost(queried, cluster.docs, patterns),
    serving,
    dfs,
    stats,
    shardOwn,
    globalStats,
    from,
    size,
    window,
    perShard,
    returned,
    merged,
    totalHits,
    maxScore: merged.length ? merged[0].score : null,
  }
}

// Which PHASE a search op is in. Everything that used to compare `op.step` to a
// literal index goes through this instead: dfs prepends a step, so the indices
// move but the keys never do. Exported because the close-up registry and the
// flight choreography both ask the same question.
export function searchStepKey(op) {
  if (!op || op.type !== 'search') return null
  return searchOpSteps(op.payload)[op.step]?.key ?? null
}

// The step INDEX of a phase, for the two places that have to drive the op to a
// named phase rather than read it (the scenarios).
export function searchStepIndex(payload, key) {
  return searchOpSteps(payload).findIndex((st) => st.key === key)
}

const searchOpSteps = (payload) =>
  payload?.dfs
    ? [STEPS[0], DFS_STEP, ...STEPS.slice(1)].map((st, i) => ({
        ...st,
        title: st.title.replace(/^\d+ · /, `${i + 1} · `),
      }))
    : STEPS

// The largest single flight (in tokens) SearchFlight will launch for a step, so
// duration() can reserve time for it. Mirrors SearchFlight's per-step batches;
// returns null for steps that launch no flight.
function searchFlightSize(search, key) {
  // The dfs round trip carries one statistics chip per query term, out and back.
  if (key === 'dfs') return search.terms.length
  if (key === 'coordinator' || key === 'scatter') return search.terms.length
  if (key === 'gather') {
    // one flight per shard with hits, up to MAX_GATHER_IDS id chips each
    const sizes = Object.values(search.returned).map((hits) =>
      Math.min(hits.length, MAX_GATHER_IDS),
    )
    return Math.max(0, ...sizes)
  }
  if (key === 'fetch') {
    // the window's winners grouped by shard, one flight per shard
    const byShard = {}
    for (const w of computeCoordinatorMerge(search).winners)
      byShard[w.shard] = (byShard[w.shard] || 0) + 1
    return Math.max(0, ...Object.values(byShard))
  }
  return null
}

export default {
  type: 'search',
  label: 'Search',
  steps: STEPS,
  // The step list is a property of the PAYLOAD, not just the type: dfs adds its
  // statistics round trip in front and renumbers everything after it. With dfs
  // off the list is STEPS unchanged, which is what keeps every scenario's
  // pinned step index valid.
  stepsFor: searchOpSteps,
  // no derive(): search never changes the cluster.

  // Further reading, shown under the explanation in "What's happening".
  docs: [
    {
      label: 'Basic read model',
      url: 'https://www.elastic.co/docs/deploy-manage/distributed-architecture/reading-and-writing-documents',
    },
    {
      label: 'Near real-time search',
      url: 'https://www.elastic.co/docs/manage-data/data-store/near-real-time-search',
    },
  ],

  extra(cluster, op) {
    return { search: computeSearch(cluster, op) }
  },

  // The one line of copy that depends on THIS query rather than the step — the
  // routing/wildcard cost, shown under the step blurb.
  note(op, extra) {
    const s = extra.search
    if (!s) return null
    const parts = []
    if (s.routing)
      parts.push(
        `routing “${s.routing}” → hash % 3 = shard ${s.routedShard}: 1 of 3 shards queried, ${s.skipped.length} idle.`,
      )
    if (s.wildcard && s.cost.total)
      parts.push(
        `${s.cost.examined} of ${s.cost.total} dictionary terms examined across ${s.cost.segments} segment${
          s.cost.segments === 1 ? '' : 's'
        } on ${s.cost.shards} shard${s.cost.shards === 1 ? '' : 's'}.`,
      )
    // Nested mapping's standing cost, stated where the reader is already looking
    // at a number: the searched shards hold this many Lucene docs to hold that
    // many documents, and the gap is paid on every query, not just this one.
    if (s.luceneScanned > s.rootsScanned)
      parts.push(
        `nested: ${s.luceneScanned} Lucene docs searched to cover ${s.rootsScanned} document${
          s.rootsScanned === 1 ? '' : 's'
        } (×${(s.luceneScanned / s.rootsScanned).toFixed(1)}). Every matching child then joins up through the parent bitset.`,
      )
    if (s.conjunctive)
      parts.push(
        'AND: every clause must match the SAME Lucene doc — which under object mapping is the whole document, sub-objects flattened together.',
      )
    // The count above comes from the FLAT model this level uses (see SPEC.md):
    // a fuzzy has no prefix to seek to, so a sorted array has to read all of it.
    // The term index one zoom down does better, and saying so here stops the
    // headline number from contradicting the picture underneath it.
    if (s.fuzzy) {
      const p = s.patterns.find((x) => x.kind === 'fuzzy')
      parts.push(
        `fuzzy: up to ${p.maxEdits} edit${p.maxEdits === 1 ? '' : 's'} — a match may differ in its very first character, so a sorted list has nothing to seek to. The real term index prunes; open the 🔍 to watch it.`,
      )
    }
    // The term the shards disagree most about. One line, not a list: the point
    // is that shard-local statistics disagree at all, not how many terms do.
    const split = s.stats && computeShardIdfs(s).find((x) => x.spread)
    if (split)
      parts.push(
        `“${split.term}” is not equally rare on every shard, so each scored it with its own idf — dfs_query_then_fetch is the search type that makes them agree.`,
      )
    return parts.length ? parts.join(' ') : null
  },

  // Content-driven steps only; undefined falls back to the step's static `ms`.
  duration(op, extra) {
    if (!extra.search) return undefined
    const key = searchStepKey(op)
    const n = searchFlightSize(extra.search, key)
    if (n == null) return undefined
    // Two steps run a flight OUT and a flight BACK, so their budget covers both:
    // the fetch phase (GET _source, then the documents) and the dfs round trip
    // (the request, then every shard's statistics).
    const requestPad = key === 'fetch' || key === 'dfs' ? FETCH_REQUEST_MS : 0
    return requestPad + flightMs(n) + FLIGHT_PAD_MS
  },
}

// The close-up (shard inspector) walks these steps to show what ONE shard does
// during the query phase. They are independent of the global op (which stays
// frozen on the search `local` step while the inspector is open) and are driven
// by a mini-stepper inside the inspector. Shaped like the op steps above.
//
// A wildcard query gets a different dictionary step (the pattern has to be
// RESOLVED, not just looked up) plus an extra expansion step, so the inspector
// addresses steps by `key` rather than by index.
const PLAIN_LOCAL_STEPS = [
  {
    key: 'analyze',
    title: '1 · Analyze the query',
    blurb:
      'The shard analyzes the query string with the same analyzer used at index time, turning it into the list of terms to look up.',
  },
  {
    key: 'lookup',
    title: '2 · Look up terms per segment',
    blurb:
      'A shard is several immutable segments, each with its OWN term dictionary. Every query term is looked up in every segment’s dictionary to find that term’s posting list.',
  },
  {
    key: 'stats',
    title: '3 · Collect term statistics',
    blurb:
      'Each segment’s term metadata already carries that term’s docFreq, so the shard sums them and computes ONE idf before a single posting list is read. These are this shard’s own statistics, not the cluster’s — dfs_query_then_fetch is the search type that fixes that.',
  },
  {
    key: 'postings',
    title: '4 · Walk the posting lists',
    blurb:
      'Each matched term’s posting list names the docs that contain it — ids only, not the documents themselves. Their union (across terms and segments) is the candidate set. A delete is near-real-time just like a write: until a refresh applies it, a tombstoned doc is still a candidate. After the refresh its posting entries are still here — struck through — but search steps over them; only a merge removes them for good.',
  },
  {
    key: 'score',
    title: '5 · Score each candidate',
    blurb:
      'Each candidate is scored with BM25: how often the term appears in it, damped by the document’s length, weighted by the idf above. A common term is worth little; a rare one in a short document is worth a lot.',
  },
  {
    key: 'topk',
    title: '6 · Keep the top hits',
    // The one step whose SIMPLIFICATION is worth naming out loud. This app
    // scores every candidate and then slices (computeSearch, above); Lucene
    // prunes instead, and a reader who knows that is owed a pointer.
    //
    // This used to be unshowable: WAND's pruning lives on the GAP between a rare
    // term's upper bound and a common term's, and that gap is IDF, which a
    // term-frequency score does not have. Now that the score IS BM25 the bounds
    // run the right way round, so the obstacle is scope, not honesty — see
    // SPEC.md's flagged simplifications. Still prose and a link rather than a
    // zoom, and the dataset is small enough that a pruning animation would have
    // little to skip.
    blurb:
      'A fixed-size priority queue keeps only the size highest-scoring docs; lower scores are evicted as better ones arrive. This is the shard’s local ranking. Scoring every candidate first, as this app does, is a simplification: real Lucene runs WAND / Block-Max WAND',
    link: {
      label: 'Magic WAND: faster retrieval of top hits',
      url: 'https://www.elastic.co/blog/faster-retrieval-of-top-hits-in-elasticsearch-with-block-max-wand',
    },
  },
  {
    key: 'return',
    title: '7 · Return ids + scores',
    blurb:
      'The shard returns only doc ids + scores to the coordinator — not the documents.',
  },
]

const seekBlurb = (patterns) => {
  const prefixes = patterns.map((p) => `“${p.seekPrefix}”`).join(', ')
  return `The term dictionary is SORTED, and this pattern has a literal prefix — so the segment jumps straight to where ${prefixes} would sit (a binary search here; real Lucene seeks through an FST + block-tree) and then reads forward only while the prefix still matches. It stops at the first term that doesn’t. Everything outside that range is never touched.`
}

const ENUMERATE_BLURB =
  'A leading wildcard has NO literal prefix, so there is nothing to jump to — a match could sit anywhere in the sorted dictionary. The only option is to read every single term and test it: in this segment, in every other segment, on every shard. That is what makes “*term” expensive.'

// A fuzzy is in exactly the same position as a leading wildcard AT THIS LEVEL,
// and it is worth saying so in its own words rather than calling it a wildcard —
// and worth pointing at the zoom, where the real index does better.
const FUZZY_ENUMERATE_BLURB =
  'A fuzzy match may differ in its very first character, so there is no literal prefix to jump to — against a flat sorted list the match could be anywhere, and every term gets read and tested. That is what this level models. The real term dictionary is not a flat list, though: one zoom down, the 🔍 shows the same query rejecting whole branches unread.'

function patternLocalSteps(patterns) {
  const seekable = patterns.every((p) => p.seekPrefix)
  const fuzzy = patterns.some((p) => p.kind === 'fuzzy')
  return [
    {
      key: 'analyze',
      title: '1 · Parse the pattern',
      blurb: `This is a pattern, not a plain term: it gets matched against the dictionary rather than looked up in it. ${patterns
        .map((p) => `“${p.raw}” — ${patternLabel(p)}`)
        .join(' · ')}.`,
    },
    {
      key: 'lookup',
      title: seekable ? '2 · Seek the term dictionary' : '2 · Enumerate the term dictionary',
      blurb: seekable ? seekBlurb(patterns) : fuzzy ? FUZZY_ENUMERATE_BLURB : ENUMERATE_BLURB,
    },
    {
      key: 'expand',
      title: '3 · Expand to matching terms',
      blurb: fuzzy
        ? 'Every term within the edit budget is collected. From here on the fuzzy query is just a boolean OR over those terms — the expensive part is already done, and it was the dictionary work. Read the list: edit distance compares SPELLING, so anything close enough is in, whether or not you meant it.'
        : 'Every term the pattern matched is collected. From here on the wildcard is just a boolean OR over those terms — the expensive part is already done, and it was the dictionary work, not the matching.',
    },
    ...PLAIN_LOCAL_STEPS.slice(2).map((s, i) => ({
      ...s,
      title: s.title.replace(/^\d+ · /, `${i + 4} · `),
    })),
  ]
}

// Two steps that only exist when there is something to show:
//
//   `intersect` when the query is conjunctive — otherwise a candidate that fails
//   the AND just disappears between the postings step and the score step, and
//   the single most important question the reader has ("why is that one not
//   here?" / "where did they all go?") is answered by nothing at all.
//
//   `join` when the shard holds nested blocks — the moment several Lucene docs
//   become the one Elasticsearch document the client asked about. It is drawn
//   even for a flat hit, as a row of one, because it is the same operation with
//   nothing to gather.
const INTERSECT_STEP = {
  key: 'intersect',
  title: 'Intersect: every clause must hit the SAME Lucene doc',
  blurb:
    'The clauses are ANDed, so a candidate only survives if it satisfies ALL of them — and it has to satisfy them on ONE Lucene doc. This is where object and nested part company. Under object mapping the whole document is one Lucene doc, so two clauses can agree on it while matching values that were never on the same sub-object: a false positive no query can detect. Under nested mapping each sub-object is its own Lucene doc, so the clauses must agree WITHIN one child. A candidate that matched only some clauses is struck out here, with the clause it failed.',
}

const JOIN_STEP = {
  key: 'join',
  title: 'Join: Lucene docs → the document you asked about',
  blurb:
    'A match is on a Lucene doc; the client asked about an Elasticsearch document. Every surviving match is rolled up to the document that owns it, and several matching variants of one product collapse into that single product — scores gathered as they go. Real Lucene does this by walking a cached per-segment bitset of “which docs are roots” forward from each match, which is why the root is written last and why the join costs something on every query. From here on there are no Lucene docs left: only documents, and only those ever leave the shard.',
}

export function localSearchSteps(patterns, { blocks = false } = {}) {
  const base = isPatternQuery(patterns) ? patternLocalSteps(patterns) : PLAIN_LOCAL_STEPS
  const conjunctive = isConjunctive(patterns)
  if (!conjunctive && !blocks) return base

  const out = []
  for (const s of base) {
    out.push(s)
    if (s.key === 'postings') {
      if (conjunctive) out.push(INTERSECT_STEP)
      if (blocks) out.push(JOIN_STEP)
    }
  }
  // Renumber, since the step titles carry their own ordinal.
  return out.map((s, i) => ({
    ...s,
    title: s.title.replace(/^\d+ · /, ''),
  })).map((s, i) => ({ ...s, title: `${i + 1} · ${s.title}` }))
}

// The coordinator close-up walks these steps to show how the coordinator turns
// the shards' local hits into the fetch decision and the final response. Like
// the local-search steps they are independent of the global op (which stays
// frozen on the search `gather` or `fetch` step while the inspector is open).
export const COORD_MERGE_STEPS = [
  {
    key: 'arrive',
    title: '1 · Hits arrive from every shard',
    blurb:
      'Each contacted shard reports its local top hits — doc ids + scores only, never the full documents. The coordinator now holds one small list per shard.',
  },
  {
    key: 'merge',
    title: '2 · Merge into one list',
    blurb:
      'The per-shard lists are concatenated into a single candidate list. Each hit remembers which shard it came from — the coordinator will need that address later.',
  },
  {
    key: 'sort',
    title: '3 · Sort by score',
    blurb:
      'The merged list is sorted by score (ties broken by doc id) to produce the GLOBAL ranking. A shard’s local #1 can lose to another shard’s #2 here. Each score was computed from its own shard’s statistics, so this ranking compares numbers that were not measured on the same scale.',
  },
  {
    key: 'cut',
    title: '4 · Cut to the winners',
    blurb:
      'Only the requested window of top results survives (the from + size of the query). Everything below the cut is ranked out — those documents are never fetched, which is the whole point of query-then-fetch.',
  },
  {
    key: 'group',
    title: '5 · Group winners by shard',
    blurb:
      'The winners are grouped by the shard that holds them, becoming one GET _source request per shard. Only shards that own a winner get a fetch request at all.',
  },
  {
    key: 'fetch',
    title: '6 · Fetch _source & respond',
    blurb:
      'The shards return the full _source for just the winning ids. The coordinator slots the documents into the ranked order and returns the response to the client.',
  },
]

// What each queried shard thought the query's terms were worth. The SAME term
// can be rarer on one shard than another simply because of how the documents
// routed, and query_then_fetch never reconciles that — so the coordinator sorts
// scores that were not measured on the same scale. Derived, never written into
// copy, because it is only a lesson if the numbers are the live ones.
export function computeShardIdfs(search) {
  const sids = Object.keys(search.stats)
    .map(Number)
    .sort((a, b) => a - b)
  const terms = [...new Set(sids.flatMap((sid) => [...search.stats[sid].byTerm.keys()]))]
    .filter((t) => matchesAny(t, search.patterns))
    .sort((a, b) => a.localeCompare(b))
  return terms
    .map((term) => {
      const rows = sids.map((shard) => {
        const st = search.stats[shard]
        const docFreq = st.byTerm.get(term)?.docFreq ?? 0
        return {
          shard,
          docFreq,
          docCount: st.docCount,
          idf: docFreq ? idf(docFreq, st.docCount) : 0,
        }
      })
      // A shard that has never seen the term scores it 0 either way, so it is
      // not evidence of disagreement — only the shards that CAN score it count.
      const seen = rows.filter((r) => r.docFreq)
      const lo = Math.min(...seen.map((r) => r.idf))
      const hi = Math.max(...seen.map((r) => r.idf))
      return { term, rows, spread: seen.length > 1 && hi - lo > 1e-9, gap: hi - lo }
    })
    .sort((a, b) => b.gap - a.gap)
}

// The coordinator's gather→fetch decision, as data for the coordinator
// inspector. A thin pure projection of computeSearch's output; winners/byShard
// use the same slice + grouping as SearchFlight's fetch step so the close-up
// always agrees with the main stage. A routed query simply arrives with one
// shard's list instead of three.
export function computeCoordinatorMerge(search) {
  const from = search.from ?? 0
  const size = search.size ?? SEARCH_SIZE
  // The lanes show what each shard SENT, which is already its local top window.
  const arrivals = Object.entries(search.returned).map(([sid, hits]) => ({
    shard: Number(sid),
    ...search.serving[sid],
    hits,
  }))
  const winners = search.merged.slice(from, from + size)
  const cut = [...search.merged.slice(0, from), ...search.merged.slice(from + size)]
  const byShard = {}
  for (const w of winners) (byShard[w.shard] ||= []).push(w)
  return {
    arrivals,
    merged: search.merged,
    winners,
    cut,
    byShard,
    from,
    size,
    n: size,
    idfs: computeShardIdfs(search),
  }
}

// The shard-local query phase, as data for the inspector's stepped close-up. Pure
// like computeSearch, and uses the SAME scoring as computeSearch so the numbers
// here match the cluster-level results panel.
export function computeShardSearch(shard, patterns, docs, size = SEARCH_SIZE, stats) {
  // The SAME statistics computeSearch scores with, from the same helper, so the
  // numbers in this panel cannot drift from the cluster-level results. Phase-2
  // dfs passes its global stats in; left out, a shard uses its own.
  const shardOwn = shardStats(shard, docs)
  const scoring = stats ?? shardOwn
  const segments = shard.segments
    .filter((seg) => seg.searchable)
    .map((seg) => {
      // The dictionary the close-up draws and the trace it replays are the terms
      // physically on disk — a purged (refreshed-away) delete still has its
      // entries until a merge. Live-docs filtering happens below, on candidates.
      const rows = segmentInvertedIndex(seg, docs, { includePurged: true })
      return {
        id: seg.id,
        rows,
        // How this segment's dictionary is actually resolved — the trace the
        // close-up replays probe by probe.
        scan: dictionaryScan(rows.map((r) => r.term), patterns),
      }
    })

  // Candidate docs = those in a matched (query-term) posting list AND still live.
  // A refresh applies a delete by clearing the doc's live-docs bit (`purged`),
  // so search steps over it even though its posting entries sit there until the
  // next merge.
  const candidateSet = new Set()
  for (const seg of segments)
    for (const row of seg.rows)
      if (matchesAny(row.term, patterns))
        for (const id of row.docIds) if (!docs[id]?.purged) candidateSet.add(id)
  const candidates = [...candidateSet].sort((a, b) => a.localeCompare(b))

  // Scored at the LUCENE doc level -- this is what the postings actually
  // addressed, and for a nested block it is the CHILDREN that score.
  const luceneScored = candidates
    .map((docId) => ({ docId, ...scoreDoc(docs[docId], patterns, scoring) }))
    .sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))

  // Candidates that failed the conjunction, kept rather than dropped so the view
  // can SHOW the elimination. `survivors` is what goes on to be joined.
  const eliminated = luceneScored.filter((h) => h.eliminated)
  const survivors = luceneScored.filter((h) => h.matched)

  // The block join, as a replayable list of hops: each surviving child and the
  // document it rolls up to. Empty for a flat dataset, where every Lucene doc is
  // already its own root.
  const joins = survivors
    .filter((h) => docRootId(docs[h.docId]) !== h.docId)
    .map((h) => ({ child: h.docId, root: docRootId(docs[h.docId]), score: h.score }))

  // The join as the view draws it: one row per DOCUMENT, listing the Lucene docs
  // that collapsed into it. A flat hit is a row of one, which is the honest
  // picture — it is the same operation, it just has nothing to gather.
  const joinRows = [...new Set(survivors.map((h) => docRootId(docs[h.docId])))].map((root) => ({
    root,
    from: survivors.filter((h) => docRootId(docs[h.docId]) === root).map((h) => h.docId),
  }))

  // Rolled up to Elasticsearch documents. `perTerm` is re-derived at the root so
  // the results panel keeps showing which terms a hit actually contained.
  const scored = joinToRoots(luceneScored, docs)
    .map(({ docId, score }) => ({
      docId,
      score,
      perTerm: mergePerTerm(luceneScored, docs, docId),
      terms: mergeTerms(luceneScored, docs, docId),
    }))
    .sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))

  const topk = scored.slice(0, size).map(({ docId, score }) => ({ docId, score }))
  const matchedTerms = [...new Set(segments.flatMap((s) => s.scan.matched))].sort((a, b) =>
    a.localeCompare(b),
  )
  const examined = segments.reduce((n, s) => n + s.scan.examined, 0)
  const dictTotal = segments.reduce((n, s) => n + s.scan.total, 0)

  return {
    segments,
    // Both are shown on the `stats` step: what this shard knows, and what it
    // actually scored with (the same thing unless dfs replaced it).
    shardOwn,
    scoring,
    candidates,
    luceneScored,
    eliminated,
    survivors,
    joins,
    joinRows,
    scored,
    topk,
    size,
    matchedTerms,
    examined,
    dictTotal,
  }
}
