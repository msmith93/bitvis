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

// ---- Shard inspector (components/ShardInspector.jsx) -----------------------
export const INSPECTOR_DWELL_MS = 2400 // per-step auto-play dwell (room for flights + layout moves)
export const INSPECTOR_FLIGHT_PAD_MS = 250
export const QUERY_SCAN_MS = 1000 // QueryBox analyze-step scan-line
