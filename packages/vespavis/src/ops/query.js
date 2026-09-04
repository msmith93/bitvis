import { CONTENT_NODES } from '../cluster'
import { MODES, runQuery } from '../ranking'
import { flightMs, FLIGHT_PAD_MS, GATHER_LEAD_MS } from '../timing'

// The `query` op. Read-only — no derive(), so it never folds into the cluster.
//
// The step list is not fixed: it is built from the QUERY. A rank profile with no
// second-phase does not get a second-phase step, because nothing happens there,
// and inventing a beat for it would teach that every query pays for every phase.
// A recommendation gets an extra step at the front, because it genuinely needs
// a round trip to the content cluster before the real query can be built.
// Which phases a query runs is a property of what you asked for, and making that
// visible in the footer is the point.

const ALL_STEPS = {
  // Recommendation only. The query vector is not embedded from text — it is
  // READ out of a user document. Vespa's own recommendation tutorial does this
  // as two separate queries from the client, and a production app would move it
  // into a custom Searcher; either way it is application logic running in the
  // stateless tier, which is what that tier is for.
  fetchUser: {
    key: 'fetchUser',
    ms: 2400,
    title: '1 · The container fetches the user',
    blurb:
      'select profile from user where user_id contains … — a first, tiny query to the content cluster for one document. Its profile tensor is what the real query will search with, so nothing else can start until it comes back.',
  },
  parse: {
    key: 'parse',
    ms: 2200,
    title: '1 · The container prepares the query',
    blurb:
      'The query hits a stateless container. Searchers in the chain rewrite and enrich it, the text is analyzed into terms, and — if the profile needs one — the query text is run through the same embedding model the documents went through, so query and documents land in one vector space by construction.',
  },
  dispatch: {
    key: 'dispatch',
    ms: 1900,
    title: '2 · Dispatch to every content node',
    blurb:
      'The container sends the query to ALL content nodes at once. Every node holds some of the buckets, so every node has work to do — there is no copy-selection decision to make first.',
  },
  match: {
    key: 'match',
    ms: 2400,
    title: '3 · Matching, in the Ready sub-database',
    blurb:
      'Each node matches against its own Ready sub-database — and only over the buckets it is ACTIVE for. Exactly one replica of each bucket is active, which is what stops a redundancy-2 cluster from returning every document twice.',
  },
  first: {
    key: 'first',
    ms: 2200,
    title: '4 · first-phase — a cheap score for every match',
    blurb:
      'Every matched document gets a first-phase score, interleaved with matching itself. This is the only phase whose cost scales with how many documents matched, so it has to stay cheap: an attribute lookup, a BM25 sum, a distance already computed during the vector search.',
  },
  second: {
    key: 'second',
    ms: 2200,
    title: '5 · second-phase — rerank the local top-k',
    blurb:
      'Each node re-scores only its own best rerank-count documents with a more expensive expression. Still on the content node, still with no network involved, but now over a handful of documents instead of all of them.',
  },
  merge: {
    key: 'merge',
    ms: 2400, // overridden by duration() — the gather flight
    title: '6 · Return and merge',
    blurb:
      'Each node returns its top hits as an id, a relevance score and any match-features the profile declared. No field values at all — nothing you could show a user has crossed the network yet. The container merges every node’s list into one global ranking.',
  },
  global: {
    key: 'global',
    ms: 2400,
    title: '7 · global-phase — rerank in the container',
    blurb:
      'The most expensive model runs here, on the merged top-k, in the stateless tier. It is the first place in the system that can see hits from every node at once — which is why cross-hit normalization and late-interaction scoring live here and nowhere else.',
  },
  fill: {
    key: 'fill',
    ms: 2400, // overridden by duration() — the summary flight
    title: '8 · Summary fill, then render',
    blurb:
      'Only now does content move. The container asks each node for the document summaries of the hits that actually made the final list, and renders the response. Everything before this shipped ids and floats.',
  },
}

// The step list a given query actually runs, renumbered so the footer reads
// 1..n rather than skipping numbers.
export function queryStepsFor(payload) {
  const m = MODES[payload?.mode] || MODES.lexical
  const keys = []
  if (m.usesProfile) keys.push('fetchUser')
  keys.push('parse', 'dispatch', 'match', 'first')
  if (m.secondPhase) keys.push('second')
  keys.push('merge')
  if (m.globalPhase) keys.push('global')
  keys.push('fill')
  return keys.map((k, i) => ({
    ...ALL_STEPS[k],
    title: ALL_STEPS[k].title.replace(/^\d+ · /, `${i + 1} · `),
  }))
}

// Address steps by KEY, never by index — the list changes shape per query.
export const queryStepKey = (op) => queryStepsFor(op.payload)[op.step]?.key ?? null

const ORDER = [
  'fetchUser',
  'parse',
  'dispatch',
  'match',
  'first',
  'second',
  'merge',
  'global',
  'fill',
]

export default {
  type: 'query',
  label: 'Query',
  steps: queryStepsFor({ mode: 'hybrid' }), // the longest shape, for the registry
  stepsFor: queryStepsFor,

  note(op, extra) {
    const s = extra.search
    if (!s) return null
    const m = MODES[s.mode]
    const bits = []

    if (m.usesProfile)
      bits.push(
        `The query vector is ${op.payload.userName}’s stored profile — a tensor attribute read out of a user document, not a model output. Nothing was embedded to run this query.`,
      )
    else if (m.usesVector && !s.queryVector)
      bits.push(
        'The embedding model recognised nothing in this query, so the vector half has nothing to search with — try one of the example queries.',
      )
    else if (m.usesVector && s.topic)
      bits.push(
        `The query embedding points at the ${s.topic.label} arc, so nearestNeighbor returns the ${s.config.targetHits} closest documents per node whether or not they share a word with the query.`,
      )

    if (s.preFilter)
      bits.push(
        `category has attribute: fast-search, so the filter ran FIRST: ${s.totalFilteredOut} documents were excluded before the graph was walked, and every neighbour returned is one that matches.`,
      )
    else if (s.postFilter) {
      const asked = Object.values(s.perNode).reduce(
        (t, p) => t + Math.min(p.annScanned, s.config.targetHits),
        0,
      )
      bits.push(
        `category has no fast-search, so the filter could not run first: the graph was walked unrestricted and the filter applied to what came back. Of the ${asked} neighbours the cluster paid to find, ${s.totalPostFilterDropped} were thrown away — work done for hits nobody gets. Turn fast-search on and that cost goes to zero.`,
      )
    }

    return bits.join(' ') || null
  },

  extra(cluster, op) {
    const search = runQuery(cluster, op.payload, op.payload.config)
    const key = queryStepKey(op)
    // "Has the query got to this phase yet?", for every phase in ORDER.
    //
    // Indexed against THIS query's own step list, not against ORDER, and that
    // distinction is the whole point: a profile with no global-phase must
    // report at.global === false forever. Ranking the phases by their position
    // in ORDER instead made a semantic query light up the container's
    // global-phase slot — reading "rerank 0" — on its last step, which says
    // the phase ran and found nothing rather than that it does not exist.
    const keys = queryStepsFor(op.payload).map((s) => s.key)
    const idx = keys.indexOf(key)
    const at = {}
    for (const k of ORDER) {
      const i = keys.indexOf(k)
      at[k] = i >= 0 && i <= idx
    }
    return { search, phase: key, at, userName: op.payload.userName || null }
  },

  duration(op, extra) {
    const key = queryStepKey(op)
    const s = extra.search
    if (!s) return undefined
    if (key === 'merge')
      return GATHER_LEAD_MS + flightMs(Math.min(s.totalReturned, 12)) + FLIGHT_PAD_MS
    if (key === 'fill')
      return GATHER_LEAD_MS + flightMs(Math.max(1, s.final.length)) + FLIGHT_PAD_MS
    return undefined
  },
}

export const QUERY_NODES = CONTENT_NODES.length
