// Every animation-scheduling constant lives here so the pieces that must stay
// in sync (a JS timeout, the framer transition it waits for, the step budget
// that reserves time for both) share one named value instead of repeating a
// literal across files. Same convention as opensearchvis.

// ---- Chip flights (components/ChipFlight.jsx) ------------------------------
// A batch of n chips staggers FLIGHT_STAGGER_MS apart; each chip travels for
// FLIGHT_CHIP_TRAVEL_S seconds. flightMs is the scheduling budget for the
// whole batch: step durations that launch a flight use it so the flight is
// never clipped by the next step.
export const FLIGHT_STAGGER_MS = 110
export const FLIGHT_CHIP_TRAVEL_S = 0.85
export const flightMs = (n) => 750 + FLIGHT_STAGGER_MS * n

// Padding added on top of a content-driven flight so the chips visibly land
// before auto-play advances.
export const FLIGHT_PAD_MS = 550

// Pod chips that appear on the stage in the same step as an incoming flight
// fade in after this delay, so the chip seems to materialize as the flight
// lands (rather than pre-existing while its own arrival is still in the air).
export const POD_APPEAR_DELAY_S = 0.45

// ---- Synthetic user traffic (useTraffic + RequestFlight) -------------------
// One request per tick; each hop of the request chip takes REQ_HOP_S, and a
// flight record lives REQ_FLIGHT_TTL_MS before being pruned. TTL must cover
// the longest flight (4 hops out + return) so chips are never cut short.
export const TRAFFIC_TICK_MS = 5000
export const REQ_HOP_S = 0.3
export const REQ_FLIGHT_TTL_MS = 2600
