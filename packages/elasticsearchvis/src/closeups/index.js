import * as shardLocal from './stages/shardLocal'
import * as coordMerge from './stages/coordMerge'
import * as segment from './stages/segment'
import * as shardFetch from './stages/shardFetch'
import { segmentInvertedIndex } from '../invertedIndex'
import { computeCoordinatorMerge } from '../ops/search'
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
//   { kind: 'fetch', shard }                        — a shard answering GET _source
//   { kind: 'segment', shard, seg, term? }          — inside one segment: the four
//                                                     tiles (.tip .tim .doc .fdt)
//   { kind: 'segment', shard, seg, phase: 'fetch', ids }
//                                                   — the same view, opened for
//                                                     the fetch of those ids
//
// `segment` is the ON-DISK zoom: it is opened from inside the shard close-up
// (query phase) or the fetch close-up (fetch phase), so it is always nested and
// inherits its validity from the stack root. Only root kinds appear in the
// predicates below. It serves a plain term, a wildcard and a fuzzy — same
// picture, the query decides how the walk behaves.

const SEARCH_LOCAL_STEP = 2 // ops/search.js STEPS: 'local'
const SEARCH_GATHER_STEPS = [3, 4] // 'gather' + 'fetch'
const SEARCH_FETCH_STEP = 4 // 'fetch'

// Which shards the fetch phase asks: those holding a winner of the cut.
export function fetchShards(search) {
  return search ? computeCoordinatorMerge(search).byShard : {}
}

// The zoom offered on a shard card for the current op/step, or null.
export function shardCloseUp(op, shardId, search) {
  if (op?.type !== 'search') return null
  if (op.step === SEARCH_LOCAL_STEP) return search?.serving?.[shardId] ? 'shard' : null
  if (op.step === SEARCH_FETCH_STEP) return fetchShards(search)[shardId] ? 'fetch' : null
  return null
}

// The zoom offered on the coordinator's node column.
export function coordCloseUp(op) {
  return op?.type === 'search' && SEARCH_GATHER_STEPS.includes(op.step)
    ? 'coordinator'
    : null
}

// Auto-close: is this open close-up still valid for the current op/step? Only
// the stack ROOT is checked — a nested zoom lives and dies with its parent.
export function closeUpStillValid(op, cu, search) {
  if (!cu || !op) return false
  if (cu.kind === 'coordinator') return coordCloseUp(op) === 'coordinator'
  if (cu.kind === 'shard') return shardCloseUp(op, cu.shard, search) === 'shard'
  if (cu.kind === 'fetch') return shardCloseUp(op, cu.shard, search) === 'fetch'
  return false
}

// The element a close-up springs out of. Shared by the panel's entrance spring
// and App's page-dive transform-origin so both aim at the same thing.
export function closeUpAnchor(cu, search) {
  switch (cu.kind) {
    case 'coordinator':
      return '[data-coordinator]'
    // The fetch goes to the copy that served the query, so both zooms spring
    // out of the same card.
    case 'shard':
    case 'fetch':
      return search?.serving?.[cu.shard]?.role === 'replica'
        ? `[data-replica-target="${cu.shard}"]`
        : `[data-shard-target="${cu.shard}"]`
    // The on-disk zoom springs out of the segment head that opened it, inside
    // the shard (or fetch) panel that is already on screen.
    case 'segment':
      return cu.phase === 'fetch' ? `[data-anat-fetch="${cu.seg}"]` : `[data-anat-dict="${cu.seg}"]`
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
    case 'fetch': {
      const shard = derived.shards.find((s) => s.id === cu.shard)
      if (!shard || !fetchShards(search)[cu.shard]) return null
      return shardFetch.build({ shard, search, docs: derived.docs, query, anchor })
    }

    // ---- the on-disk zoom, keyed on one segment of one shard ----
    case 'segment': {
      const ctx = segmentContext(cu, derived)
      if (!ctx) return null
      return segment.build({
        ...ctx,
        anchor,
        docs: derived.docs,
        term: cu.phase === 'fetch' ? null : pickTerm(cu, ctx.rows, search),
        patterns: search.patterns,
        phase: cu.phase ?? 'query',
        ids: cu.ids ?? [],
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
  // No `includePurged` here (unlike the shard anatomy one level up): the on-disk
  // FST / block-tree models are tuned to the live dictionary, and a
  // refreshed-away delete's leftover terms would perturb the block counts the
  // zoom exists to teach. It is reclaimed at the next merge anyway.
  const rows = segmentInvertedIndex(seg, derived.docs)
  if (!rows.length) return null
  return { shard, seg, segId: seg.id, rows }
}

// Which term the segment zoom seeks: the one asked for if it is really in
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
