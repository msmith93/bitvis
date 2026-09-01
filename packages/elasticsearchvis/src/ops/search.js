import { docRootId, routeShard, selectServingCopy } from '../cluster'
import { MAX_GATHER_IDS, MAX_FETCH_WINNERS, LOCAL_TOPK } from '../constants'
import { segmentInvertedIndex } from '../invertedIndex'
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
      'Each contacted shard searches its own segments’ inverted indexes, scores the matching docs (a simplified relevance score), and returns only its local top hits — doc ids + scores, not the full documents.',
  },
  {
    key: 'gather',
    ms: 1600, // overridden by duration() (hit-id flights)
    title: '4 · Gather + merge + sort',
    blurb:
      'The coordinator gathers every shard’s local hits, merges them, and sorts by score to produce the global ranking. A term shared across shards shows up here from multiple shards.',
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

// Score one LUCENE doc against the query patterns: how often each MATCHING term
// occurs in it. `perTerm` is keyed by the real term, not the pattern, so a
// wildcard shows which terms it actually hit. For a plain term query this is
// identical to the term-frequency count the app has always used (a stand-in for
// BM25).
//
// Two refinements, both inert unless the query uses them:
//   a field-qualified clause only counts terms from THAT field;
//   a conjunctive query scores 0 unless EVERY clause matched this one doc.
//
// That second rule is the entire object-vs-nested lesson, and it is deliberately
// one function for both: under `object` the whole document is one Lucene doc, so
// clauses agree across sub-objects that were never together; under `nested` each
// child is its own Lucene doc, so they have to agree within one child.
export function scoreDoc(doc, patterns) {
  const perTerm = {}
  let score = 0
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
      // Counted once per TERM, not once per matching clause — the frequency the
      // app has always shown.
      if (matched) {
        perTerm[term] = (perTerm[term] || 0) + 1
        score += 1
      }
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
    return { score: 0, perTerm: {}, clauses, eliminated: true }
  return { score, perTerm, clauses, eliminated: false }
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
    if (h.score <= 0 || docRootId(docs[h.docId]) !== rootId) continue
    for (const [term, n] of Object.entries(h.perTerm)) out[term] = (out[term] || 0) + n
  }
  return out
}

function joinToRoots(luceneHits, docs) {
  const byRoot = new Map()
  for (const { docId, score } of luceneHits) {
    if (score <= 0) continue
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
  // A routing key hashes to exactly one shard — the only shard that can hold a
  // doc indexed with that key, so it is the only shard worth asking.
  const routedShard = routing ? routeShard(routing) : null
  const queried =
    routedShard == null
      ? cluster.shards
      : cluster.shards.filter((s) => s.id === routedShard)

  const serving = {} // shardId -> { node, role }   (queried shards only)
  const perShard = {} // shardId -> [{ docId, score }]
  // What the query actually had to look at: Lucene docs, against the
  // Elasticsearch documents they add up to. Identical on a flat dataset; on a
  // nested one the first number is the multiplier, and it is paid on every query.
  let luceneScanned = 0
  let rootsScanned = 0

  for (const shard of queried) {
    serving[shard.id] = selectServingCopy(shard)

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
      const { score } = scoreDoc(doc, patterns)
      if (score > 0) luceneHits.push({ docId: id, score })
    }
    // Matches are on LUCENE docs; the client asked about Elasticsearch
    // documents, so every hit is joined up to the root of its block.
    const hits = joinToRoots(luceneHits, cluster.docs)
    hits.sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))
    perShard[shard.id] = hits
  }

  const merged = Object.entries(perShard)
    .flatMap(([sid, hits]) => hits.map((h) => ({ ...h, shard: Number(sid) })))
    .sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))

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
    perShard,
    merged,
  }
}

// The largest single flight (in tokens) SearchFlight will launch for a step, so
// duration() can reserve time for it. Mirrors SearchFlight's per-step batches;
// returns null for steps that launch no flight.
function searchFlightSize(search, step) {
  if (step === 0 || step === 1) return search.terms.length // query / fan-out flights
  if (step === 3) {
    // one flight per shard with hits, up to MAX_GATHER_IDS id chips each
    const sizes = Object.values(search.perShard).map((hits) =>
      Math.min(hits.length, MAX_GATHER_IDS),
    )
    return Math.max(0, ...sizes)
  }
  if (step === 4) {
    // top winners grouped by shard, one flight per shard
    const byShard = {}
    for (const w of search.merged.slice(0, MAX_FETCH_WINNERS))
      byShard[w.shard] = (byShard[w.shard] || 0) + 1
    return Math.max(0, ...Object.values(byShard))
  }
  return null
}

export default {
  type: 'search',
  label: 'Search',
  steps: STEPS,
  // no derive(): search never changes the cluster.

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
    return parts.length ? parts.join(' ') : null
  },

  // Content-driven steps only; undefined falls back to the step's static `ms`.
  duration(op, extra) {
    if (!extra.search) return undefined
    const n = searchFlightSize(extra.search, op.step)
    if (n == null) return undefined
    // Step 4 (fetch) runs two flights back to back — the GET _source request,
    // then (once it lands) the response — so its budget has to cover both.
    const requestPad = op.step === 4 ? FETCH_REQUEST_MS : 0
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
    key: 'postings',
    title: '3 · Walk the posting lists',
    blurb:
      'Each matched term’s posting list names the docs that contain it — ids only, not the documents themselves. Their union (across terms and segments) is the candidate set. A delete is near-real-time just like a write: until a refresh applies it, a tombstoned doc is still a candidate. After the refresh its posting entries are still here — struck through — but search steps over them; only a merge removes them for good.',
  },
  {
    key: 'score',
    title: '4 · Score each candidate',
    blurb:
      'Each candidate is scored by how often the query terms appear in it. Real Lucene uses BM25 (term frequency, inverse document frequency, field-length norm); here we simplify to a term-frequency count.',
  },
  {
    key: 'topk',
    title: '5 · Keep the top hits',
    blurb:
      'A fixed-size priority queue keeps only the k highest-scoring docs; lower scores are evicted as better ones arrive. This is the shard’s local ranking.',
  },
  {
    key: 'return',
    title: '6 · Return ids + scores',
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
      'The merged list is sorted by score (ties broken by doc id) to produce the GLOBAL ranking. A shard’s local #1 can lose to another shard’s #2 here.',
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

// The coordinator's gather→fetch decision, as data for the coordinator
// inspector. A thin pure projection of computeSearch's output; winners/byShard
// use the same slice + grouping as SearchFlight's fetch step so the close-up
// always agrees with the main stage. A routed query simply arrives with one
// shard's list instead of three.
export function computeCoordinatorMerge(search, n = MAX_FETCH_WINNERS) {
  const arrivals = Object.entries(search.perShard).map(([sid, hits]) => ({
    shard: Number(sid),
    ...search.serving[sid],
    hits,
  }))
  const winners = search.merged.slice(0, n)
  const cut = search.merged.slice(n)
  const byShard = {}
  for (const w of winners) (byShard[w.shard] ||= []).push(w)
  return { arrivals, merged: search.merged, winners, cut, byShard, n }
}

// The shard-local query phase, as data for the inspector's stepped close-up. Pure
// like computeSearch, and uses the SAME scoring as computeSearch so the numbers
// here match the cluster-level results panel.
export function computeShardSearch(shard, patterns, docs, k = LOCAL_TOPK) {
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
    .map((docId) => ({ docId, ...scoreDoc(docs[docId], patterns) }))
    .sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))

  // Candidates that failed the conjunction, kept rather than dropped so the view
  // can SHOW the elimination. `survivors` is what goes on to be joined.
  const eliminated = luceneScored.filter((h) => h.eliminated)
  const survivors = luceneScored.filter((h) => h.score > 0)

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
    }))
    .sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))

  const topk = scored.slice(0, k).map(({ docId, score }) => ({ docId, score }))
  const matchedTerms = [...new Set(segments.flatMap((s) => s.scan.matched))].sort((a, b) =>
    a.localeCompare(b),
  )
  const examined = segments.reduce((n, s) => n + s.scan.examined, 0)
  const dictTotal = segments.reduce((n, s) => n + s.scan.total, 0)

  return {
    segments,
    candidates,
    luceneScored,
    eliminated,
    survivors,
    joins,
    joinRows,
    scored,
    topk,
    k,
    matchedTerms,
    examined,
    dictTotal,
  }
}
