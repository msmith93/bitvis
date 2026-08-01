import { matchesAny } from './wildcard'

// Relevance: Lucene's BM25, the real formula with the real constants.
//
//   score(D, t) = idf(t) · ( tf · (k1 + 1) ) / ( tf + k1 · (1 - b + b · |D|/avgdl) )
//   idf(t)      = ln( 1 + (N - n + 0.5) / (n + 0.5) )
//
// Three factors, and the whole lesson is that they pull in different directions:
//   tf         how often the term occurs HERE — but saturating, so the 10th
//              occurrence is worth far less than the 2nd (that is what k1 does).
//   idf        how rare the term is in the COLLECTION — a term everything
//              contains discriminates nothing.
//   |D|/avgdl  how long this document is against the average — a hit in a short
//              document means more than the same hit buried in a long one (b).
//
// The collection statistics (N and n) are the interesting part in a distributed
// index, because there are two honest answers to "the collection":
//
//   'shard'   each shard scores with its OWN docCount and docFreq. This is what
//             plain query_then_fetch does, and it is why a document can rank
//             differently depending on which shard it happened to route to — a
//             small shard inflates idf for everything it holds.
//   'global'  the coordinator collects every shard's stats first and hands the
//             totals back out, so every shard scores against the same numbers.
//             That extra round trip is exactly what dfs_query_then_fetch buys.
//
// See SPEC.md for the flagged simplifications (one combined text field rather
// than per-field norms, and an exact field length where Lucene quantizes the
// norm into a single byte).

export const K1 = 1.2
export const B = 0.75

// Lucene BM25Similarity.idf. Rises as the term gets rarer; never negative.
export const idf = (docCount, docFreq) =>
  Math.log(1 + (docCount - docFreq + 0.5) / (docFreq + 0.5))

// |D|. This app models ONE text field per document (title + body together), so
// the length is simply how many terms the document analyzed to.
export const fieldLength = (doc) =>
  doc ? doc.tokens.title.length + doc.tokens.body.length : 0

// Scores are floats now, so every render site must go through this — a raw
// 0.4923076923076923 in a chip is unreadable and jitters the layout.
export const fmtScore = (n) => (Number.isFinite(n) ? n.toFixed(3) : '—')

export const EMPTY_STATS = { docCount: 0, totalLength: 0, avgFieldLength: 0, docFreq: {} }

// How often each MATCHING term occurs in a doc, keyed by the real term rather
// than the pattern — so a wildcard or fuzzy query shows which terms it hit.
export function termFrequencies(doc, patterns) {
  const tf = {}
  if (!doc) return tf
  for (const field of ['title', 'body'])
    for (const term of doc.tokens[field])
      if (matchesAny(term, patterns)) tf[term] = (tf[term] || 0) + 1
  return tf
}

// Score one doc against the query patterns under a given set of collection
// stats. `perTerm` carries every input the formula used, not just the result,
// so the scoring close-up can render the arithmetic instead of asserting it
// (SPEC: every number on screen must come from the model).
export function scoreDoc(doc, patterns, stats = EMPTY_STATS) {
  const length = fieldLength(doc)
  // A shard that somehow reports no documents would divide by zero; fall back to
  // this doc's own length so the norm factor becomes exactly 1.
  const avgdl = stats.avgFieldLength || length || 1
  const norm = K1 * (1 - B + (B * length) / avgdl)

  const perTerm = {}
  let score = 0
  for (const [term, tf] of Object.entries(termFrequencies(doc, patterns))) {
    const docFreq = stats.docFreq[term] ?? 0
    const termIdf = idf(stats.docCount, docFreq)
    const saturation = (tf * (K1 + 1)) / (tf + norm)
    const contribution = termIdf * saturation
    perTerm[term] = { tf, docFreq, idf: termIdf, norm, saturation, contribution }
    score += contribution
  }
  return { score, perTerm, length, avgdl }
}
