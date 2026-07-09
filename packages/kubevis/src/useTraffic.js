import { useEffect, useRef, useState } from 'react'
import { routeRequest } from './cluster'
import { TRAFFIC_TICK_MS, REQ_FLIGHT_TTL_MS } from './timing'

// The ambient traffic layer: a synthetic user fires one request every
// TRAFFIC_TICK_MS, entirely OUTSIDE the op machinery. Each tick evaluates routeRequest against
// the currently RENDERED (derived) cluster — so traffic reacts live to mid-op
// states and stepper scrubbing (pods that are ContainerCreating don't serve;
// drain a node mid-walk and watch outcomes change). Flights are decorative
// records pruned after REQ_FLIGHT_TTL_MS; outcomes/stats are the substance.
export function useTraffic(cluster) {
  const [paused, setPaused] = useState(false)
  const [stats, setStats] = useState({ ok: 0, fail: 0 })
  const [recent, setRecent] = useState([]) // last 8 outcomes
  const [flights, setFlights] = useState([])
  const rr = useRef(0) // round-robin cursor across endpoints
  const seq = useRef(0)
  // The interval closure reads the latest cluster through a ref so we don't
  // tear down and recreate the timer on every derived-cluster change.
  const clusterRef = useRef(cluster)
  clusterRef.current = cluster

  useEffect(() => {
    if (paused) return
    const id = setInterval(() => {
      const route = routeRequest(clusterRef.current)
      let podName = null
      let nodeId = null
      let svcName = route.service?.name ?? route.ingress?.serviceName ?? null
      if (route.outcome === 'ok') {
        const ep = route.endpoints[rr.current++ % route.endpoints.length]
        podName = ep.name
        nodeId = ep.node
      }
      const flight = {
        id: `req-${seq.current++}`,
        outcome: route.outcome,
        podName,
        nodeId,
        svcName,
      }
      setFlights((fs) => [...fs, flight])
      setTimeout(
        () => setFlights((fs) => fs.filter((f) => f.id !== flight.id)),
        REQ_FLIGHT_TTL_MS,
      )
      setStats((s) =>
        route.outcome === 'ok'
          ? { ...s, ok: s.ok + 1 }
          : { ...s, fail: s.fail + 1 },
      )
      setRecent((r) => [...r.slice(-7), route.outcome])
    }, TRAFFIC_TICK_MS)
    return () => clearInterval(id)
  }, [paused])

  return { paused, setPaused, stats, recent, flights }
}
