// A deliberately small stand-in for the Elasticsearch "standard" analyzer.
//
// The real standard analyzer uses a Unicode text segmentation tokenizer and a
// lowercase token filter (and NO stopword removal by default). We approximate
// the pedagogically important parts: split text into terms on whitespace and
// punctuation, then lowercase. We do not stem, fold accents, or remove
// stopwords -- keeping the mapping from "your words" -> "terms" obvious.
export function analyze(text) {
  if (!text) return []
  return text
    .toLowerCase()
    // split on anything that isn't a letter, number, or apostrophe
    .split(/[^\p{L}\p{N}']+/u)
    .filter((t) => t.length > 0)
}

// Analyze a field bag -- { fieldName: value } -- into a { field: [terms] } map.
// The field SET comes from the document, not from a hardcoded pair: an
// Elasticsearch document is whatever fields its mapping declares, and a nested
// child's fields are named by their full path ("variants.color"). A flat
// { title, body } doc analyzes to exactly what it always did.
//
// Numbers index as a single term. Real Elasticsearch indexes a numeric field as
// points rather than terms, so range queries work; a term lookup on an exact
// value is the part this app teaches, and it behaves the same either way.
export function analyzeDoc(fields) {
  const out = {}
  for (const [field, value] of Object.entries(fields)) {
    if (value == null) continue
    if (typeof value === 'string') out[field] = analyze(value)
    else if (typeof value === 'number') out[field] = [String(value)]
    // A MULTI-VALUED field: one field, several values, one flat term list. This
    // is exactly what `object` mapping does to an array of sub-objects, and it
    // is why the pairing between them is lost -- the terms all land in the same
    // list with nothing recording which value they arrived with.
    else if (Array.isArray(value))
      out[field] = value.flatMap((v) =>
        typeof v === 'number' ? [String(v)] : typeof v === 'string' ? analyze(v) : [],
      )
  }
  return out
}
