// Every animation-scheduling constant lives here so the pieces that must stay
// in sync (a JS timeout, the framer transition it waits for, the step budget
// that reserves time for both) share one named value instead of repeating a
// literal across files. Same convention as kubevis/opensearchvis.

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

// ---- Ring walk (components/Ring.jsx) ---------------------------------------
// The replica walk highlights one ring stop every RING_WALK_STEP_MS; the walk
// step's duration budgets RING_WALK_STEP_MS × stops so the sweep completes
// before auto-play advances.
export const RING_WALK_STEP_MS = 650
