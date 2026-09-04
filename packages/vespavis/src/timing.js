// Every animation-scheduling constant lives here so the pieces that must stay
// in sync — a JS timeout, the framer transition it waits for, the step budget
// that reserves time for both — share one named value.

// ---- Chip flights (components/tokenFlight.jsx) -----------------------------
export const FLIGHT_STAGGER_MS = 90
export const FLIGHT_TOKEN_TRAVEL_S = 0.85
export const flightMs = (n) => 750 + FLIGHT_STAGGER_MS * n

// Padding on top of a content-driven flight so chips visibly land before the
// step advances.
export const FLIGHT_PAD_MS = 400

// ---- Feed choreography ------------------------------------------------------
// The indexing chain step: the scan line sweeps the document, terms and the
// embedding appear, and only then do they fly to the content nodes.
export const FEED_SCAN_MS = 800
export const FEED_PROCESS_LEAD_MS = 1900

// ---- Query choreography -----------------------------------------------------
// A gather/fill flight waits this long before launching, so a node visibly
// answers a request rather than just handing something over.
export const GATHER_LEAD_MS = 700
export const QUERY_SCAN_MS = 1000
