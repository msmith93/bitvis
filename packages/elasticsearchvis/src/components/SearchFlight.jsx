import { useEffect, useRef, useState } from 'react'
import { MAX_GATHER_IDS, MAX_FETCH_WINNERS } from '../constants'
import { stepKey } from '../ops/search'
import FlyingTokens, { selectorRect } from './tokenFlight'

const truncate = (s, n = 24) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '—')

// Scatter-gather choreography for the search op, driven by the live op step (the
// footer's auto-play paces it). Mirrors the index overlay's flight approach.
// Steps are addressed by KEY, not index — a dfs_query_then_fetch search has a
// pre-query round in front and every index after it shifts:
//
//   dfs         : terms fly coordinator → every shard, stats fly back (DFS only)
//   coordinator : query flies search box → coordinator (Node 1)
//   scatter     : query fans out coordinator → one serving copy per shard
//   local       : scan sweeps the serving shards (handled in ClusterStage)
//   gather      : matched doc-id chips fly shard → coordinator
//   fetch       : full documents (titles) fly winners' shards → coordinator
export default function SearchFlight({ op, search, docs }) {
  const [flights, setFlights] = useState([]) // [{ key, from, to, tokens, variant }]
  const firedRef = useRef(null)

  useEffect(() => {
    if (!op || op.type !== 'search' || !search) {
      firedRef.current = null
      setFlights((f) => (f.length ? [] : f))
      return
    }
    const key = stepKey(op)
    // The signature carries the search type too: the same query re-run as a DFS
    // sits on differently-numbered steps, and must be allowed to fire again.
    const sig = `${key}:${search.searchType}:${search.terms.join(',')}`
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

    if (key === 'dfs') {
      // The pre-query round: each shard reports what it knows about the
      // collection — how many docs it holds, and each term's document frequency.
      for (const id of Object.keys(search.serving)) {
        const from = servingRect(id)
        const st = search.stats?.perShard?.[id]
        if (!from || !coord || !st) continue
        const tokens = [
          { id: `n-${id}`, term: `N ${st.docCount}`, color: 'var(--accent-2)' },
          ...search.terms.map((t, i) => ({
            id: `df-${id}-${i}-${t}`,
            term: `${t} df ${st.docFreq[t] ?? 0}`,
            color: 'var(--accent-2)',
          })),
        ]
        next.push({ key: `${sig}-${id}`, from, to: coord, tokens })
      }
    } else if (key === 'coordinator') {
      const from = selectorRect('[data-search-source]')
      if (from && coord && termTokens.length)
        next.push({ key: sig, from, to: coord, tokens: termTokens })
    } else if (key === 'scatter') {
      for (const id of Object.keys(search.serving)) {
        const to = servingRect(id)
        if (coord && to && termTokens.length)
          next.push({ key: `${sig}-${id}`, from: coord, to, tokens: termTokens })
      }
    } else if (key === 'gather') {
      for (const [id, hits] of Object.entries(search.perShard)) {
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
    } else if (key === 'fetch') {
      const byShard = {}
      for (const w of search.merged.slice(0, MAX_FETCH_WINNERS)) (byShard[w.shard] ||= []).push(w)
      for (const [id, ws] of Object.entries(byShard)) {
        const from = servingRect(id)
        if (!from || !coord) continue
        const tokens = ws.map((w) => ({
          id: `f-${id}-${w.docId}`,
          term: truncate(docs[w.docId]?.title),
          color: docs[w.docId]?.color,
        }))
        next.push({ key: `${sig}-${id}`, from, to: coord, tokens, variant: 'doc' })
      }
    }

    setFlights(next)
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
      onComplete={() => removeFlight(f.key)}
    />
  ))
}
