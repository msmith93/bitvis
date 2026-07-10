import { flightMs, FLIGHT_PAD_MS } from '../timing'
import { stepsFor } from './index'

// Standard duration() for op modules: steps that launch chip flights budget
// the longest flight in the batch plus a landing pad on top of the step's
// reading dwell; flight-less steps fall back to their static `ms`.
// Payload-aware (steps may be a function), so it reads the instance's list.
export function flightAwareDuration() {
  return (op, extra) => {
    const flights = extra.flights ?? []
    if (flights.length === 0) return undefined
    const longest = Math.max(...flights.map((f) => f.tokens.length))
    return stepsFor(op)[op.step].ms + flightMs(longest) + FLIGHT_PAD_MS
  }
}
