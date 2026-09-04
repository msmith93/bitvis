// The query model: matching, and the ranking phases that run over what matched.
//
// Vespa ranks in up to four phases, and WHERE each one runs is the whole point:
//
//   match          content node — find the documents worth scoring at all
//   first-phase    content node — a cheap score for EVERY matched document
//   second-phase   content node — an expensive score for the local top-k
//   global-phase   CONTAINER    — the most expensive score, on the merged top-k
//
// Each phase sees fewer documents than the one before it and is allowed to cost
// more. A model too expensive to run on a million documents runs happily on
// twenty, and global-phase is where it runs — after the merge, in the stateless
// tier, where it can also see hits from every content node at once.
//
// Every number below comes from the schema config (see schema.js), so editing
// the schema panel edits what actually happens here.

import { BM25_B, BM25_K1, HITS } from './constants'
import { activeReadyDocs, CONTENT_NODES } from './cluster'
import { analyze, DEFAULT_SCHEMA_CONFIG } from './schema'
import { angularDistance, closeness, embed, lexiconHits, nearestTopic } from './vectors'

// ---- Query modes ------------------------------------------------------------
// Each mode is one real Vespa query shape plus the rank profile that goes with
// it. The YQL is what you would actually send.
export const MODES = {
  lexical: {
    id: 'lexical',
    label: 'Text search',
    short: 'BM25',
    useCase: 'search',
    blurb:
      'Classic lexical retrieval. The text is analyzed into terms, matched against the index fields, and scored with BM25.',
    yql: () => 'select * from product where userQuery()',
    profileName: 'bm25',
    profile: () => `rank-profile bm25 {
  first-phase {
    expression: bm25(title) + bm25(description)
  }
}`,
    usesText: true,
    usesVector: false,
    secondPhase: false,
    globalPhase: false,
  },

  semantic: {
    id: 'semantic',
    label: 'Vector search',
    short: 'ANN',
    useCase: 'search',
    blurb:
      'Semantic retrieval. The query text is embedded into the same vector space as the documents, and the HNSW index over the tensor attribute returns the nearest neighbours — terms need never overlap.',
    yql: (cat, c) =>
      `select * from product where {targetHits: ${c.targetHits}}nearestNeighbor(embedding, q)`,
    profileName: 'semantic',
    profile: () => `rank-profile semantic {
  inputs {
    query(q) tensor<float>(x[2])
  }
  first-phase {
    expression: closeness(field, embedding)
  }
}`,
    usesText: false,
    usesVector: true,
    secondPhase: false,
    globalPhase: false,
  },

  hybrid: {
    id: 'hybrid',
    label: 'Hybrid + rerank',
    short: 'hybrid',
    useCase: 'search',
    blurb:
      'Both retrievers at once, ORed into one query tree, then three ranking phases: a cheap blend on every match, popularity folded in for the local top-k, and late interaction in the container on the merged top-k.',
    yql: (cat, c) =>
      `select * from product where userQuery() or ({targetHits: ${c.targetHits}}nearestNeighbor(embedding, q))`,
    profileName: 'hybrid',
    profile: (c) => `rank-profile hybrid {

  inputs {
    query(q) tensor<float>(x[2])
  }

  function lexical() {
    expression: bm25(title) + bm25(description)
  }

  # Late interaction: score the query against every
  # passage and keep the best. 1/(2 - cos) is
  # closeness for angular distance.
  function passage_closeness() {
    expression: reduce(1.0 / (2.0 - sum(query(q) * attribute(passages), x)), max, p)
  }

  first-phase {
    expression: closeness(field, embedding) + ${c.lexicalWeight} * lexical
  }

  second-phase {
    rerank-count: ${c.secondPhaseRerankCount}
    expression: firstPhase + 0.3 * attribute(popularity)
  }

  global-phase {
    rerank-count: ${c.globalPhaseRerankCount}
    expression: 0.5 * normalize_linear(firstPhase) + 0.5 * passage_closeness
  }

  match-features {
    closeness(field, embedding)
    attribute(passages)
    lexical
  }
}`,
    usesText: true,
    usesVector: true,
    secondPhase: true,
    globalPhase: true,
  },

  filtered: {
    id: 'filtered',
    label: 'Filtered vector',
    short: 'pre-filter',
    useCase: 'search',
    blurb:
      'A structured filter combined with vector search. Whether the filter runs BEFORE the graph walk or after it is decided by one line in the schema — `attribute: fast-search` on the filtered field.',
    yql: (cat, c) =>
      `select * from product where category contains "${cat}"\n  and ({targetHits: ${c.targetHits}}nearestNeighbor(embedding, q))`,
    profileName: 'semantic',
    profile: () => `rank-profile semantic {
  inputs {
    query(q) tensor<float>(x[2])
  }
  first-phase {
    expression: closeness(field, embedding)
  }
}`,
    usesText: false,
    usesVector: true,
    usesFilter: true,
    secondPhase: false,
    globalPhase: false,
  },

  // ---- Recommendation ------------------------------------------------------
  // The query vector is not embedded from text: it IS a stored tensor, read out
  // of a user document by the container before the search runs. That two-step
  // shape is how Vespa's own recommendation tutorial does it, and it is a good
  // picture of what the stateless tier is for — application logic that needs
  // one round trip before the real query can be built.
  recommend: {
    id: 'recommend',
    label: 'Recommendation',
    short: 'user tensor',
    useCase: 'recommend',
    blurb:
      'The container reads the user document, takes their profile tensor, and uses it as the query vector for a nearest-neighbour search over products. No text is involved at any point.',
    yql: (cat, c) =>
      `select * from product where {targetHits: ${c.targetHits}}nearestNeighbor(embedding, user_profile)`,
    profileName: 'recommendation',
    profile: () => `rank-profile recommendation {
  inputs {
    query(user_profile) tensor<float>(x[2])
  }
  first-phase {
    expression: closeness(field, embedding)
  }
}`,
    usesText: false,
    usesVector: true,
    usesProfile: true,
    secondPhase: false,
    globalPhase: false,
  },
}

export const MODE_LIST = Object.values(MODES)
export const modesFor = (useCase) => MODE_LIST.filter((m) => m.useCase === useCase)

// ---- BM25 -------------------------------------------------------------------
// Vespa's bm25 rank feature, with its documented defaults k1 = 1.2, b = 0.75.
//
// The statistics are PER CONTENT NODE. Vespa computes document frequency and
// average field length from the documents on the node, not across the cluster,
// so the same document can score slightly differently on two nodes. That is
// real, it is documented, and this app reproduces it rather than smoothing it
// away — see the per-node BM25 numbers in the results panel.
function fieldStats(docIds, docs, field) {
  let total = 0
  const df = new Map()
  for (const id of docIds) {
    const terms = docs[id]?.terms?.[field] || []
    total += terms.length
    for (const t of new Set(terms)) df.set(t, (df.get(t) || 0) + 1)
  }
  return { n: docIds.length, avgdl: docIds.length ? total / docIds.length : 0, df }
}

function bm25Field(doc, field, queryTerms, stats) {
  const terms = doc.terms?.[field] || []
  if (!terms.length || !stats.n) return 0
  const dl = terms.length
  let score = 0
  for (const q of new Set(queryTerms)) {
    const tf = terms.filter((t) => t === q).length
    if (!tf) continue
    const n = stats.df.get(q) || 0
    const idf = Math.log(1 + (stats.n - n + 0.5) / (n + 0.5))
    const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / (stats.avgdl || 1))
    score += (idf * (tf * (BM25_K1 + 1))) / denom
  }
  return score
}

// ---- The global-phase model -------------------------------------------------
// global-phase exists so a model too expensive for the content nodes can run on
// the merged top-k. The interesting question is not "is it slower" but WHAT IT
// CAN SEE that the cheap phases could not — and there are two answers here,
// both of them real Vespa.
//
// 1. GRANULARITY. HNSW needs one point per document, so the schema pools title
//    and description into a single `embedding`. That average is what
//    `closeness(field, embedding)` scored on the content node. A short precise
//    title gets blurred by a long description and vice versa. The per-passage
//    vectors ride up to the container as a match-feature, and global-phase
//    scores the query against each of them and keeps the BEST — late
//    interaction, the same shape as a ColBERT MaxSim profile.
//
// 2. CROSS-HIT NORMALIZATION. A content node cannot normalize its scores
//    against hits it never saw. The container can, and `normalize_linear` is a
//    global-phase-only feature for exactly that reason.
//
// It is a stand-in, not a transformer. What it stands in for is real: the phase
// that looks again, at a granularity retrieval had to give up.
export function passageCloseness(doc, queryVector) {
  if (!queryVector || !doc.passages) return 0
  const parts = Object.values(doc.passages).filter(Boolean)
  if (!parts.length) return 0
  return Math.max(...parts.map((p) => closeness(angularDistance(queryVector, p))))
}

const round = (x) => Math.round(x * 1000) / 1000

// ---- The query --------------------------------------------------------------
//
// `runQuery` is the whole model: it returns everything the stage, the stepper
// and the results panel need, phase by phase, so nothing in the view has to
// recompute a score or invent a number.
export function runQuery(
  cluster,
  { mode = 'lexical', text = '', category = null, userProfile = null },
  config = DEFAULT_SCHEMA_CONFIG,
) {
  const c = { ...DEFAULT_SCHEMA_CONFIG, ...config }
  const m = MODES[mode] || MODES.lexical
  const terms = m.usesText ? analyze(text) : []
  const qTerms = analyze(text)

  // The query vector. For a text mode it is produced by the same `embed`
  // expression the documents went through, so query and documents land in one
  // space by construction. For recommendation it is not produced at all — it is
  // READ, out of the user's document, by the container.
  const queryVector = m.usesProfile
    ? userProfile || null
    : m.usesVector
    ? embed(qTerms)
    : null
  const known = lexiconHits(qTerms)
  const topic = nearestTopic(queryVector)

  // Pre-filter or post-filter? Decided by one line in the schema.
  //
  // With `attribute: fast-search`, the filter is an index lookup: Vespa can
  // evaluate it cheaply up front and restrict the graph walk to documents
  // already known to pass, so every neighbour it returns is a neighbour you
  // wanted. Without it, evaluating the filter over the whole corpus first is
  // not cheap, so the walk runs unrestricted and the filter is applied to what
  // comes back — and you asked for targetHits and get however many of them
  // happened to match. That shortfall is the entire reason the setting exists.
  const preFilter = !!(m.usesFilter && category && c.categoryFastSearch)
  const postFilter = !!(m.usesFilter && category && !c.categoryFastSearch)

  const perNode = {}

  for (const node of cluster.nodes) {
    const ready = activeReadyDocs(node, cluster.docs)
    const passed = preFilter
      ? ready.filter((id) => cluster.docs[id].category === category)
      : ready

    const titleStats = fieldStats(ready, cluster.docs, 'title')
    const descStats = fieldStats(ready, cluster.docs, 'description')

    // ---- MATCH ---------------------------------------------------------
    const lexicalMatches = new Set()
    if (m.usesText && terms.length)
      for (const id of passed) {
        const d = cluster.docs[id]
        const all = [...(d.terms.title || []), ...(d.terms.description || [])]
        if (terms.some((t) => all.includes(t))) lexicalMatches.add(id)
      }

    const annMatches = new Set()
    let annScanned = 0
    let postFilterDropped = 0
    if (m.usesVector && queryVector) {
      const ranked = passed
        .map((id) => ({ id, d: angularDistance(queryVector, cluster.docs[id].embedding) }))
        .filter((r) => Number.isFinite(r.d))
        .sort((a, b) => a.d - b.d)
      annScanned = ranked.length
      const returnedByGraph = ranked.slice(0, c.targetHits)
      for (const r of returnedByGraph) {
        // The post-filter runs HERE — after the walk has already spent its
        // budget. Anything it drops is a hit the graph paid for and nobody
        // gets.
        if (postFilter && cluster.docs[r.id].category !== category) {
          postFilterDropped++
          continue
        }
        annMatches.add(r.id)
      }
    }

    const matchedIds = [...new Set([...lexicalMatches, ...annMatches])]

    // ---- FIRST PHASE ---------------------------------------------------
    // Every matched document gets a score. This is the only phase whose cost
    // scales with how many documents matched, which is why it has to be cheap.
    const lexRaw = new Map()
    for (const id of matchedIds) {
      const d = cluster.docs[id]
      lexRaw.set(
        id,
        bm25Field(d, 'title', terms, titleStats) +
          bm25Field(d, 'description', terms, descStats),
      )
    }

    const scored = matchedIds.map((id) => {
      const d = cluster.docs[id]
      const dist = queryVector ? angularDistance(queryVector, d.embedding) : Infinity
      const close = m.usesVector ? closeness(dist) : 0
      const lexical = lexRaw.get(id) || 0
      // A hybrid first-phase is a weighted sum with a tuned constant, not a
      // normalized blend: first-phase runs per document and has no idea what
      // the other documents scored.
      let first
      if (m.id === 'lexical') first = lexical
      else if (m.usesText && m.usesVector) first = close + c.lexicalWeight * lexical
      else first = close
      return {
        id,
        node: node.id,
        via: { lexical: lexicalMatches.has(id), ann: annMatches.has(id) },
        bm25: round(lexical),
        distance: Number.isFinite(dist) ? round(dist) : null,
        closeness: round(close),
        popularity: d.popularity,
        first: round(first),
        second: null,
        global: null,
      }
    })
    scored.sort((a, b) => b.first - a.first || a.id.localeCompare(b.id))

    // ---- SECOND PHASE --------------------------------------------------
    // Only the local top rerank-count are re-scored. Everything below the cut
    // keeps its first-phase score and can still be returned — second-phase
    // REORDERS the head, it does not truncate the tail.
    let reranked = 0
    if (m.secondPhase) {
      for (const h of scored.slice(0, c.secondPhaseRerankCount)) {
        h.second = round(h.first + 0.3 * h.popularity)
        reranked++
      }
      scored.sort(
        (a, b) => (b.second ?? b.first) - (a.second ?? a.first) || a.id.localeCompare(b.id),
      )
    }

    // What actually crosses the network: the node's own top hits, as
    // (global id, rank score) plus any match-features the profile asked for.
    // No field values at all. That is why a second network phase exists.
    const returned = scored.slice(0, HITS).map((h) => ({ ...h }))

    perNode[node.id] = {
      node: node.id,
      readyCount: ready.length,
      passedFilter: passed.length,
      filteredOut: preFilter ? ready.length - passed.length : 0,
      postFilterDropped,
      annScanned,
      matched: matchedIds.length,
      lexicalMatches: lexicalMatches.size,
      annMatches: annMatches.size,
      reranked,
      scored,
      returned,
    }
  }

  // ---- MERGE (container) ----------------------------------------------
  const merged = CONTENT_NODES.flatMap((n) => perNode[n.id]?.returned || [])
    .map((h) => ({ ...h, score: h.second ?? h.first }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))

  // ---- GLOBAL PHASE (container) ---------------------------------------
  let global = merged
  let globalReranked = 0
  if (m.globalPhase && merged.length) {
    const window = merged.slice(0, c.globalPhaseRerankCount)
    // normalize_linear over the reranked window. Only the container can do
    // this: it is the first place in the system that has seen every node's
    // hits at once.
    const lo = Math.min(...window.map((h) => h.score))
    const hi = Math.max(...window.map((h) => h.score))
    const norm = (s) => (hi > lo ? (s - lo) / (hi - lo) : 1)
    const head = window.map((h) => {
      const g = passageCloseness(cluster.docs[h.id], queryVector)
      globalReranked++
      return {
        ...h,
        nodeScore: h.score,
        normalized: round(norm(h.score)),
        global: round(g),
        score: round(0.5 * norm(h.score) + 0.5 * g),
      }
    })
    const tail = merged.slice(c.globalPhaseRerankCount)
    // Reranked hits stay AHEAD of the ones global-phase never looked at. The
    // two groups' scores are on different scales — one has been through an
    // extra model — so interleaving them by score would be comparing numbers
    // that do not mean the same thing.
    head.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    global = [...head, ...tail]
  }

  // ---- SUMMARY FILL ----------------------------------------------------
  // Only now does any document CONTENT move. The container asks each content
  // node for the summaries of the hits that actually made the final list.
  const final = global.slice(0, HITS)
  const fillByNode = {}
  for (const h of final) (fillByNode[h.node] ||= []).push(h.id)

  return {
    mode: m.id,
    config: c,
    text,
    terms,
    knownTerms: known,
    queryVector,
    topic,
    category: m.usesFilter ? category : null,
    preFilter,
    postFilter,
    yql: m.yql(category, c),
    perNode,
    merged,
    global,
    final,
    fillByNode,
    globalReranked,
    totalMatched: Object.values(perNode).reduce((t, p) => t + p.matched, 0),
    totalReturned: Object.values(perNode).reduce((t, p) => t + p.returned.length, 0),
    totalFilteredOut: Object.values(perNode).reduce((t, p) => t + p.filteredOut, 0),
    totalPostFilterDropped: Object.values(perNode).reduce(
      (t, p) => t + p.postFilterDropped,
      0,
    ),
  }
}
