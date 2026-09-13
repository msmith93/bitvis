// BM25 — the relevance score itself, and nothing else. Pure arithmetic over
// numbers the levels below have already produced: a term's document frequency
// (src/invertedIndex.js's shardStats, summed out of what each segment's .tim
// term metadata carries), the term's frequency in one doc (src/postings.js), and
// the doc's field length.
//
// Lucene's BM25Similarity, with its defaults. Two details worth keeping honest
// because they are the ones people get wrong when they write the formula out
// from memory:
//
//   1. The idf denominator uses docCount — the number of documents that have a
//      value for the field — not maxDoc. Here the two coincide (every doc has
//      tokens), but the name is the accurate one.
//   2. Lucene OMITS the (k1 + 1) numerator factor that the textbook formula
//      carries. It is a constant multiplier, so it cannot change a ranking; the
//      scores Elasticsearch reports are the ones without it, and a picture that
//      added it would disagree with a real _score for no gain.
//
// The score of a document is the sum of its matching terms' contributions — one
// TermQuery each, ORed together, which is what a multi-term query is.

// Elasticsearch's defaults, unexposed on purpose: this is a guided POC, not a
// tuning surface (SPEC.md). k1 controls how fast term frequency saturates, b how
// hard field length is punished.
export const K1 = 1.2
export const B = 0.75

// How much one occurrence is worth: a term in nearly every document carries
// almost no information, a term in one document carries a lot. The +0.5 terms
// are the smoothing that keeps a term appearing in more than half the documents
// from going negative.
export function idf(docFreq, docCount) {
  return Math.log(1 + (docCount - docFreq + 0.5) / (docFreq + 0.5))
}

// Term frequency, saturating, with the document's length divided out. Two
// occurrences are worth more than one but nowhere near twice as much, and the
// same two occurrences are worth more in a short document than in a long one —
// which is the half of BM25 that a plain frequency count cannot express.
export function tfNorm(freq, fieldLen, avgFieldLen) {
  // A shard with no documents has no average to divide by; it also has no
  // candidates to score, so this only guards the arithmetic.
  const avg = avgFieldLen || 1
  return freq / (freq + K1 * (1 - B + B * (fieldLen / avg)))
}

// One term's contribution to one document's score.
export function termScore({ freq, docFreq, docCount, fieldLen, avgFieldLen }) {
  return idf(docFreq, docCount) * tfNorm(freq, fieldLen, avgFieldLen)
}

// The ONE place a score becomes text. Elasticsearch reports a float with far
// more digits than a reader can hold; two decimals is enough to see a ranking
// and short enough to sit in a chip. Sorting always happens on the full float
// (see computeSearch), so two chips CAN show the same number while being
// ordered on a difference below what is printed.
//
// Small scores get more digits, and that is not a cosmetic rule: when a term
// appears in EVERY document its idf is near zero, which is the correct answer
// and the whole point of idf — but at two decimals a shard's entire ranking
// collapses into a column of "0.01" and the lesson becomes unreadable. The
// larger sample dataset does exactly this. Scores within one shard sit in the
// same magnitude, so a column stays uniform in practice.
export const fmtScore = (n) => {
  const v = n ?? 0
  return v === 0 || Math.abs(v) >= 0.1 ? v.toFixed(2) : v.toFixed(4)
}
