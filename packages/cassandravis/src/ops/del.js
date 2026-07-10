import { makeWriteSteps, deriveWrite, writeExtra, writeDuration } from './writePath'

// The `del` op: a delete IS a write — the same path as put, but the mutation
// is a TOMBSTONE (payload.tombstone = true). The tombstone must out-timestamp
// older values on other SSTables and other replicas; the space is only
// reclaimed at compaction.
export default {
  type: 'del',
  label: 'Delete (tombstone)',
  steps: makeWriteSteps('delete'),
  derive: deriveWrite,
  extra: writeExtra,
  duration: writeDuration,
}
