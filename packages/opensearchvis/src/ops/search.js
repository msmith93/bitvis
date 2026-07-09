import { analyze } from '../analyzer'
import { selectServingCopy } from '../cluster'
import { MAX_GATHER_IDS, MAX_FETCH_WINNERS, LOCAL_TOPK } from '../constants'
import { segmentInvertedIndex } from '../invertedIndex'
import { flightMs, FLIGHT_PAD_MS } from '../timing'

// The `search` op: two-phase query-then-fetch scatter-gather. Read-only — it
// has no derive(), so applyOp leaves the committed cluster untouched.

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
      'The coordinator fans the query out to ONE copy of every shard — primary or replica — spread across the nodes. This is why a search runs on all nodes.',
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

// Run the (read-only) search against the committed cluster.
function computeSearch(cluster, op) {
  const terms = analyze(op.payload.query)
  const serving = {} // shardId -> { node, role }
  const perShard = {} // shardId -> [{ docId, score }]

  for (const shard of cluster.shards) {
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
      let score = 0
      for (const t of terms) {
        score += doc.tokens.title.filter((x) => x === t).length
        score += doc.tokens.body.filter((x) => x === t).length
      }
      if (score > 0) hits.push({ docId: id, score })
    }
    hits.sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))
    perShard[shard.id] = hits
  }

  const merged = Object.entries(perShard)
    .flatMap(([sid, hits]) => hits.map((h) => ({ ...h, shard: Number(sid) })))
    .sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))

  return { terms, serving, perShard, merged }
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
export const LOCAL_SEARCH_STEPS = [
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
      'Each matched term’s posting list names the docs that contain it. Their union (across terms and segments) is the candidate set; tombstoned / un-refreshed docs are skipped.',
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

// The shard-local query phase, as data for the inspector's stepped close-up. Pure
// like computeSearch, and uses the SAME term-frequency scoring so the numbers here
// match the cluster-level results panel.
export function computeShardSearch(shard, terms, docs, k = LOCAL_TOPK) {
  const termSet = new Set(terms)
  const segments = shard.segments
    .filter((seg) => seg.searchable)
    .map((seg) => ({ id: seg.id, rows: segmentInvertedIndex(seg, docs) }))

  // Candidate docs = those appearing in a matched (query-term) posting list.
  const candidateSet = new Set()
  for (const seg of segments)
    for (const row of seg.rows)
      if (termSet.has(row.term)) for (const id of row.docIds) candidateSet.add(id)
  const candidates = [...candidateSet].sort((a, b) => a.localeCompare(b))

  const scored = candidates
    .map((docId) => {
      const doc = docs[docId]
      const perTerm = {}
      let score = 0
      for (const t of terms) {
        const tf =
          doc.tokens.title.filter((x) => x === t).length +
          doc.tokens.body.filter((x) => x === t).length
        if (tf > 0) {
          perTerm[t] = tf
          score += tf
        }
      }
      return { docId, perTerm, score }
    })
    .sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))

  const topk = scored.slice(0, k).map(({ docId, score }) => ({ docId, score }))
  return { segments, candidates, scored, topk, k }
}
