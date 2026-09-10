import { useEffect, useRef, useState } from 'react'
import { MAX_GATHER_IDS } from '../constants'
import FlyingTokens, { selectorRect } from './tokenFlight'
import { computeCoordinatorMerge } from '../ops/search'
import { FETCH_REQUEST_MS } from '../timing'

const truncate = (s, n = 24) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '—')

// Scatter-gather choreography for the search op, driven by the live op step (the
// footer's auto-play paces it). Mirrors the index overlay's flight approach:
//
//   step 0 coordinator : query flies search box → coordinator (Node 1)
//   step 1 scatter      : query fans out coordinator → one serving copy per shard
//   step 2 local search : scan sweeps the serving shards (handled in ClusterStage)
//   step 3 gather       : matched doc-id chips fly shard → coordinator
//   step 4 fetch        : GET _source flies coordinator → each winner's shard,
//                         then (once it lands) the full documents fly back
export default function SearchFlight({ op, search, docs }) {
  const [flights, setFlights] = useState([]) // [{ key, from, to, tokens, variant }]
  const firedRef = useRef(null)

  useEffect(() => {
    if (!op || op.type !== 'search' || !search) {
      firedRef.current = null
      setFlights((f) => (f.length ? [] : f))
      return
    }
    const step = op.step
    const sig = `${step}:${search.terms.join(',')}`
    if (firedRef.current === sig) return // fire once per step (survives re-renders/scrub)
    firedRef.current = sig

    const coord = selectorRect('[data-coordinator]')
    const servingRect = (id) =>
      selectorRect(
        search.serving[id]?.role === 'replica'
          ? `[data-replica-target="${id}"]`
          : `[data-shard-target="${id}"]`,
      )
    const termTokens = search.terms.map((t, i) => ({
      id: `q-${i}-${t}`,
      term: t,
      color: 'var(--accent)',
    }))

    const next = []

    if (step === 0) {
      const from = selectorRect('[data-search-source]')
      if (from && coord && termTokens.length)
        next.push({ key: sig, from, to: coord, tokens: termTokens })
    } else if (step === 1) {
      for (const id of Object.keys(search.serving)) {
        const to = servingRect(id)
        if (coord && to && termTokens.length)
          next.push({ key: `${sig}-${id}`, from: coord, to, tokens: termTokens })
      }
    } else if (step === 3) {
      for (const [id, hits] of Object.entries(search.returned)) {
        if (!hits.length) continue
        const from = servingRect(id)
        if (!from || !coord) continue
        const tokens = hits.slice(0, MAX_GATHER_IDS).map((h) => ({
          id: `g-${id}-${h.docId}`,
          term: h.docId,
          color: docs[h.docId]?.color,
        }))
        next.push({ key: `${sig}-${id}`, from, to: coord, tokens })
      }
    } else if (step === 4) {
      const { byShard } = computeCoordinatorMerge(search)
      for (const [id, ws] of Object.entries(byShard)) {
        const from = servingRect(id)
        if (!from || !coord) continue
        // The request lands first — GET _source, coordinator → shard — and only
        // once it has arrives does the shard's response (the full documents)
        // fly back. `delayMs` on the response batch is what stages the two.
        next.push({
          key: `${sig}-${id}-req`,
          from: coord,
          to: from,
          tokens: [{ id: `req-${id}`, term: 'GET _source' }],
          variant: 'request',
        })
        const tokens = ws.map((w) => ({
          id: `f-${id}-${w.docId}`,
          term: truncate(docs[w.docId]?.label),
          color: docs[w.docId]?.color,
        }))
        next.push({
          key: `${sig}-${id}`,
          from,
          to: coord,
          tokens,
          variant: 'doc',
          delayMs: FETCH_REQUEST_MS,
        })
      }
    }

    // ADD this step's flights rather than replacing the array: the fetch
    // phase's response batch carries a `delayMs` (see step 4 below) and is
    // still mid-delay, not yet even visible, when auto-play's own duration
    // budget runs out and the op advances to 'return' — a step with no flight
    // of its own. Replacing here would yank that response out from under
    // itself before it ever got to fly. Each flight already removes only
    // itself (by key) once its own animation completes, so nothing leaks.
    if (next.length) setFlights((prev) => [...prev, ...next])
  }, [op, search, docs])

  function removeFlight(key) {
    setFlights((f) => f.filter((x) => x.key !== key))
  }

  return flights.map((f) => (
    <FlyingTokens
      key={f.key}
      tokens={f.tokens}
      from={f.from}
      to={f.to}
      variant={f.variant}
      delayMs={f.delayMs}
      onComplete={() => removeFlight(f.key)}
    />
  ))
}
