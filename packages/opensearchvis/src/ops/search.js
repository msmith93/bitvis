import { routeShard, selectServingCopy } from '../cluster'
import { MAX_GATHER_IDS, MAX_FETCH_WINNERS, LOCAL_TOPK } from '../constants'
import { segmentInvertedIndex } from '../invertedIndex'
import { flightMs, FLIGHT_PAD_MS } from '../timing'
import {
  PATTERN_LABEL,
  dictionaryScan,
  isWildcardQuery,
  matchesAny,
  parseQuery,
} from '../wildcard'

// The `search` op: two-phase query-then-fetch scatter-gather. Read-only — it
// has no derive(), so applyOp leaves the committed cluster untouched.
//
// Two payload options change WHERE and HOW MUCH work happens:
//   payload.routing — hash the routing key instead of scattering: exactly one
//                     shard is queried, the other two do nothing.
//   a `*` in the query — the term is a wildcard pattern that must first be
//                     expanded against each segment's term dictionary.

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
    ms: 1600, // overridden by duration() (document flights)
    title: '5 · Fetch phase',
    blurb:
      'For the winning doc ids, the coordinator asks the relevant shards for the full _source. This two-phase query-then-fetch avoids shipping full documents for non-matching hits.',
  },
  {
    key: 'return',
    ms: 1300,
    title: '6 · Return to the client',
    blurb:
      'The coordinator returns the merged, ranked results to the client. Buffered (un-refreshed) and tombstoned documents never appear.',
  },
]

// Score one doc against the query patterns: how often each MATCHING term occurs
// in it. `perTerm` is keyed by the real term, not the pattern, so a wildcard
// shows which terms it actually hit. For a plain term query this is identical to
// the term-frequency count the app has always used (a stand-in for BM25).
export function scoreDoc(doc, patterns) {
  const perTerm = {}
  let score = 0
  for (const field of ['title', 'body'])
    for (const term of doc.tokens[field])
      if (matchesAny(term, patterns)) {
        perTerm[term] = (perTerm[term] || 0) + 1
        score += 1
      }
  return { score, perTerm }
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
      const scan = dictionaryScan(
        segmentInvertedIndex(seg, docs).map((r) => r.term),
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

  for (const shard of queried) {
    serving[shard.id] = selectServingCopy(shard)

    const docIds = new Set()
    for (const seg of shard.segments)
      if (seg.searchable) for (const id of seg.docIds) docIds.add(id)

    const hits = []
    for (const id of docIds) {
      const doc = cluster.docs[id]
      // Tombstoned-but-not-yet-refreshed docs are still searchable (purged is
      // set by a refresh); only purged docs drop out of results.
      if (!doc || doc.purged) continue
      const { score } = scoreDoc(doc, patterns)
      if (score > 0) hits.push({ docId: id, score })
    }
    hits.sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))
    perShard[shard.id] = hits
  }

  const merged = Object.entries(perShard)
    .flatMap(([sid, hits]) => hits.map((h) => ({ ...h, shard: Number(sid) })))
    .sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))

  return {
    terms: patterns.map((p) => p.raw), // display strings (patterns kept verbatim)
    patterns,
    wildcard: isWildcardQuery(patterns),
    routing,
    routedShard,
    skipped: cluster.shards.filter((s) => !(s.id in serving)).map((s) => s.id),
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
    return parts.length ? parts.join(' ') : null
  },

  // Content-driven steps only; undefined falls back to the step's static `ms`.
  duration(op, extra) {
    if (!extra.search) return undefined
    const n = searchFlightSize(extra.search, op.step)
    return n != null ? flightMs(n) + FLIGHT_PAD_MS : undefined
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
      'Each matched term’s posting list names the docs that contain it — ids only, not the documents themselves. Their union (across terms and segments) is the candidate set; tombstoned / un-refreshed docs are skipped. Long lists also carry skip data so a walk can jump ahead, though Lucene writes none below 128 docs, so a segment this small has none.',
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
      'The shard returns only doc ids + scores to the coordinator — not the documents. The coordinator merges these with the other shards’ hits before fetching full sources.',
  },
]

const seekBlurb = (patterns) => {
  const prefixes = patterns.map((p) => `“${p.seekPrefix}”`).join(', ')
  return `The term dictionary is SORTED, and this pattern has a literal prefix — so the segment jumps straight to where ${prefixes} would sit (a binary search here; real Lucene seeks through an FST + block-tree) and then reads forward only while the prefix still matches. It stops at the first term that doesn’t. Everything outside that range is never touched.`
}

const ENUMERATE_BLURB =
  'A leading wildcard has NO literal prefix, so there is nothing to jump to — a match could sit anywhere in the sorted dictionary. The only option is to read every single term and test it: in this segment, in every other segment, on every shard. That is what makes “*term” expensive.'

function wildcardLocalSteps(patterns) {
  const seekable = patterns.every((p) => p.seekPrefix)
  return [
    {
      key: 'analyze',
      title: '1 · Parse the pattern',
      blurb: `This is a wildcard pattern, not a plain term: it gets matched against the dictionary rather than looked up in it. ${patterns
        .map((p) => `“${p.raw}” — ${PATTERN_LABEL[p.kind]}`)
        .join(' · ')}.`,
    },
    {
      key: 'lookup',
      title: seekable ? '2 · Seek the term dictionary' : '2 · Enumerate the term dictionary',
      blurb: seekable ? seekBlurb(patterns) : ENUMERATE_BLURB,
    },
    {
      key: 'expand',
      title: '3 · Expand to matching terms',
      blurb:
        'Every term the pattern matched is collected. From here on the wildcard is just a boolean OR over those terms — the expensive part is already done, and it was the dictionary work, not the matching.',
    },
    ...PLAIN_LOCAL_STEPS.slice(2).map((s, i) => ({
      ...s,
      title: s.title.replace(/^\d+ · /, `${i + 4} · `),
    })),
  ]
}

export function localSearchSteps(patterns) {
  return isWildcardQuery(patterns) ? wildcardLocalSteps(patterns) : PLAIN_LOCAL_STEPS
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
      const rows = segmentInvertedIndex(seg, docs)
      return {
        id: seg.id,
        rows,
        // How this segment's dictionary is actually resolved — the trace the
        // close-up replays probe by probe.
        scan: dictionaryScan(rows.map((r) => r.term), patterns),
      }
    })

  // Candidate docs = those appearing in a matched (query-term) posting list.
  const candidateSet = new Set()
  for (const seg of segments)
    for (const row of seg.rows)
      if (matchesAny(row.term, patterns)) for (const id of row.docIds) candidateSet.add(id)
  const candidates = [...candidateSet].sort((a, b) => a.localeCompare(b))

  const scored = candidates
    .map((docId) => ({ docId, ...scoreDoc(docs[docId], patterns) }))
    .sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))

  const topk = scored.slice(0, k).map(({ docId, score }) => ({ docId, score }))
  const matchedTerms = [...new Set(segments.flatMap((s) => s.scan.matched))].sort((a, b) =>
    a.localeCompare(b),
  )
  const examined = segments.reduce((n, s) => n + s.scan.examined, 0)
  const dictTotal = segments.reduce((n, s) => n + s.scan.total, 0)

  return { segments, candidates, scored, topk, k, matchedTerms, examined, dictTotal }
}
