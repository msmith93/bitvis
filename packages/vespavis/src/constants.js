// Demo-sized caps and fixed constants.
//
// The tunable ones — rerank counts, targetHits, the hybrid lexical weight —
// have MOVED to DEFAULT_SCHEMA_CONFIG in schema.js, because they are schema
// decisions the reader can now edit. What is left here is either genuinely
// fixed (Vespa's bm25 defaults) or a demo-size cap.
//
// Vespa's real defaults are an order of magnitude larger; the numbers here are
// chosen so a 14-document corpus still shows a head and a tail at every phase,
// and they are badged as such in the UI.

// How many hits the client asks for (`hits=` in the query API).
export const HITS = 5

// How many documents the memory index may hold before proton's flush engine
// runs a flush by itself. Stands in for the flush strategy's `maxmemorygain`,
// which is a memory budget in bytes — the point being that a flush is a
// THRESHOLD being crossed, not a button being pressed.
export const FLUSH_MAXMEMORYGAIN = 4

// Vespa's bm25 rank feature defaults.
export const BM25_K1 = 1.2
export const BM25_B = 0.75

// Vespa's real defaults, for the "toy-scaled" badges in the UI.
export const REAL_DEFAULTS = {
  secondPhaseRerankCount: 100,
  globalPhaseRerankCount: 100,
}
