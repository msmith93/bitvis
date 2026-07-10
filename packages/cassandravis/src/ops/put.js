import { makeWriteSteps, deriveWrite, writeExtra, writeDuration } from './writePath'

// The `put` op: client → coordinator → hash onto the ring → walk for N
// replicas → fan out to ALL of them → ack once W respond. See writePath.js
// for the shared implementation and payload shape.
export default {
  type: 'put',
  label: 'Put (write)',
  steps: makeWriteSteps('put'),
  derive: deriveWrite,
  extra: writeExtra,
  duration: writeDuration,
}
