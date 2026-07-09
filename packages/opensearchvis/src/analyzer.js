// A deliberately small stand-in for the OpenSearch "standard" analyzer.
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

// Analyze every field of a document into a { field: [terms] } map.
export function analyzeDoc(doc) {
  return {
    title: analyze(doc.title),
    body: analyze(doc.body),
  }
}
