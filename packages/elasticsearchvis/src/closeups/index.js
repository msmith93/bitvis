import * as shardLocal from './stages/shardLocal'
import * as coordMerge from './stages/coordMerge'
import * as dictionary from './stages/dictionary'
import { segmentInvertedIndex } from '../invertedIndex'
import { atStep } from '../ops/search'
import { matchesAny } from '../wildcard'

// The close-up registry: which zoom is available WHERE (which op/step, which
// shard), what element it springs out of, and how to build its ctx for the
// CloseUp shell. The 🔍 buttons and the auto-close effect both go through these
// predicates, so a glass is only ever shown for a close-up that is currently
// valid. Adding a zoom = one new module in ./stages plus a case below.
//
// A close-up handle (`cu`) is a small plain object:
//   { kind: 'shard', shard }                        — a serving shard's local search
//   { kind: 'coordinator' }                         — the coordinator's merge & fetch
//   { kind: 'dictionary', shard, seg, term }        — that segment's .tip + .tim
//
// The last is the ON-DISK zoom: it is opened from inside the shard close-up, so
// it is always nested and inherits its validity from the stack root. Only root
// kinds appear in the predicates below. It serves both a plain term and a
// wildcard — same picture, the query decides how the walk behaves.

// Which search step each zoom belongs to, BY NAME — a dfs_query_then_fetch
// search has a pre-query step in front, so every index after it shifts.
const SEARCH_LOCAL_STEP = 'local'
const SEARCH_GATHER_STEPS = ['gather', 'fetch']

// The zoom offered on a shard card for the current op/step, or null.
export function shardCloseUp(op, shardId, search) {
  if (!atStep(op, SEARCH_LOCAL_STEP)) return null
  return search?.serving?.[shardId] ? 'shard' : null
}

// The zoom offered on the coordinator's node column.
export function coordCloseUp(op) {
  return SEARCH_GATHER_STEPS.some((k) => atStep(op, k)) ? 'coordinator' : null
}

// Auto-close: is this open close-up still valid for the current op/step? Only
// the stack ROOT is checked — a nested zoom lives and dies with its parent.
export function closeUpStillValid(op, cu, search) {
  if (!cu || !op) return false
  if (cu.kind === 'coordinator') return coordCloseUp(op) === 'coordinator'
  if (cu.kind === 'shard') return shardCloseUp(op, cu.shard, search) === 'shard'
  return false
}

// The element a close-up springs out of. Shared by the panel's entrance spring
// and App's page-dive transform-origin so both aim at the same thing.
export function closeUpAnchor(cu, search) {
  switch (cu.kind) {
    case 'coordinator':
      return '[data-coordinator]'
    case 'shard':
      return search?.serving?.[cu.shard]?.role === 'replica'
        ? `[data-replica-target="${cu.shard}"]`
        : `[data-shard-target="${cu.shard}"]`
    // The on-disk zooms spring out of the column head that opened them, inside
    // the shard panel that is already on screen.
    case 'dictionary':
      return `[data-anat-dict="${cu.seg}"]`
    default:
      return null
  }
}

// Build the shell ctx for an open close-up, or null if it can't be built (the
// op moved on before the auto-close effect ran).
export function buildCloseUp(cu, { op, derived, search }) {
  if (!cu || !search) return null
  const query = op?.type === 'search' ? op.payload.query : ''
  const anchor = closeUpAnchor(cu, search)

  switch (cu.kind) {
    case 'shard': {
      const shard = derived.shards.find((s) => s.id === cu.shard)
      if (!shard || !search.serving?.[cu.shard]) return null
      return shardLocal.build({ shard, search, docs: derived.docs, query, anchor })
    }
    case 'coordinator':
      return coordMerge.build({ search, docs: derived.docs, query, anchor })

    // ---- the on-disk zoom, keyed on one segment of one shard ----
    case 'dictionary': {
      const ctx = segmentContext(cu, derived)
      if (!ctx) return null
      return dictionary.build({
        ...ctx,
        anchor,
        docs: derived.docs,
        term: pickTerm(cu, ctx.rows, search),
        patterns: search.patterns,
      })
    }
    default:
      return null
  }
}

// The segment a nested zoom is about, plus its inverted-index rows — the one
// input the on-disk models are built from.
function segmentContext(cu, derived) {
  const shard = derived.shards.find((s) => s.id === cu.shard)
  const seg = shard?.segments.find((s) => s.id === cu.seg && s.searchable)
  if (!shard || !seg) return null
  const rows = segmentInvertedIndex(seg, derived.docs)
  if (!rows.length) return null
  return { shard, seg, segId: seg.id, rows }
}

// Which term the dictionary zoom seeks: the one asked for if it is really in
// this segment, else the first term the query actually matched here, else the
// most common one (so the walk always has a real target to find).
function pickTerm(cu, rows, search) {
  if (cu.term && rows.some((r) => r.term === cu.term)) return cu.term
  const patterns = search?.patterns ?? []
  const matched = patterns.length && rows.find((r) => matchesAny(r.term, patterns))
  if (matched) return matched.term
  return [...rows].sort((a, b) => b.docIds.length - a.docIds.length)[0].term
}

export { default as CloseUp } from './CloseUp'
