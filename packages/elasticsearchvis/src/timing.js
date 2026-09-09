// Every animation-scheduling constant lives here so the pieces that must stay
// in sync (a JS timeout, the framer transition it waits for, the step budget
// that reserves time for both) share one named value instead of repeating a
// literal in four files.

// ---- Token flights (components/tokenFlight.jsx) ----------------------------
// A batch of n chips staggers FLIGHT_STAGGER_MS apart; each chip travels for
// FLIGHT_TOKEN_TRAVEL_S seconds. flightMs is the scheduling budget for the
// whole batch: the step scheduler (stepDuration) and flight-completion
// timeouts both use it so a flight is never clipped by the next step.
// NOTE: the true animation end is 850 + 90·(n−1) ms, so flightMs undershoots
// by 10ms — invisible because each chip fades out over its last 20%
// (times: [0, .15, .8, 1]). Long-standing behavior; keep as is.
export const FLIGHT_STAGGER_MS = 90
export const FLIGHT_TOKEN_TRAVEL_S = 0.85
export const flightMs = (n) => 750 + FLIGHT_STAGGER_MS * n

// The fetch-phase request (coordinator → shard, "GET _source") is always a
// single-chip flight; the response batch waits this long before it launches,
// so a shard visibly answers a request rather than just handing over a doc.
export const FETCH_REQUEST_MS = flightMs(1)

// Padding added on top of a content-driven flight so the chips visibly land
// before the step advances.
export const FLIGHT_PAD_MS = 400

// ---- Index analysis choreography (components/IndexOverlay.jsx, step 2) -----
// The step budget is INDEX_ANALYSIS_LEAD_MS + flightMs(nTokens): scan-line for
// INDEX_SCAN_MS, tokens dwell in the card until INDEX_ANALYSIS_LEAD_MS, then
// the emit flight launches. The scan-line's CSS sweep (`scan-sweep 1.3s` in
// index.css) is cut short when JS removes the element at INDEX_SCAN_MS /
// QUERY_SCAN_MS — change these together if the sweep should complete.
export const INDEX_SCAN_MS = 800
export const INDEX_ANALYSIS_LEAD_MS = 1800

// ---- Replication choreography (components/IndexOverlay.jsx, last step) -----
// What crosses the wire to the replica is the OPERATION (the document), not the
// terms — so the replica runs the whole step-2 sequence again on arrival. This
// is the budget reserved for the doc's hop primary -> replica before that scan
// starts; the hop itself is a framer spring, not a timed animation.
export const INDEX_REPLICA_HOP_MS = 900

// ---- Doc-pill peek (components/DocPeek.jsx) --------------------------------
// Hovering a doc chip on the cluster stage reveals its `_source`. Opening is
// delayed so sweeping the pointer across a segment's chips doesn't strobe a card
// per chip; closing is delayed less, but enough that crossing the 1px gap
// between two adjacent chips reads as a move, not as a close and a reopen.
export const PEEK_OPEN_MS = 180
export const PEEK_CLOSE_MS = 120

// ---- Close-ups (src/closeups/) ---------------------------------------------
export const INSPECTOR_DWELL_MS = 2400 // per-step auto-play dwell (room for flights + layout moves)
export const INSPECTOR_FLIGHT_PAD_MS = 250
export const QUERY_SCAN_MS = 1000 // QueryBox analyze-step scan-line

// ---- Term-dictionary probe replay (wildcard queries) -----------------------
// One tick per probe on the dictionary step. A seek is a handful of probes that
// should read as deliberate bounces; a full enumeration is dozens of rows, so it
// ticks much faster or the step would outstay its welcome. The step's dwell is
// computed from these (probes × ms), the same way op steps budget for flights.
export const DICT_SEEK_MS = 420
export const DICT_SCAN_MS = 130

// ---- On-disk close-ups (src/closeups/stages/{dictionary,automaton}) --------
// One tick per unit of work being replayed, so each stepped reveal is paced by
// how much work it actually represents, and the step's dwell is computed from
// (units × ms) the same way the probe replay above budgets for its probes.
export const CU_DWELL_MS = 3000 // a step with nothing to replay
export const BLOCK_READ_MS = 300 // one entry of an in-block suffix scan
export const AUTOMATON_STEP_MS = 260 // one arc decision (follow / prune) or term test — every mode
