import { motion } from 'framer-motion'
import { rectCenter, selectorRect } from './ChipFlight'
import { REQ_HOP_S } from '../timing'

// One synthetic HTTP request, animated hop by hop along the serving chain:
// user → ingress → service chip → the endpoint pod's node, then a green
// response chip returns straight to the user. Failures travel as far as the
// chain exists and die at the failing hop with the status code. Purely
// decorative — outcomes were decided by routeRequest in useTraffic.
export default function RequestFlight({ flight }) {
  const hops = [rectCenter(selectorRect('[data-fly="user"]'))]
  let fail = null

  const push = (sel) => {
    const p = rectCenter(selectorRect(sel))
    if (p) hops.push(p)
    return !!p
  }

  push('[data-fly="ingress"]')
  if (flight.outcome === 'no-rule' || flight.outcome === 'no-service') {
    fail = flight.outcome === 'no-rule' ? '404' : '503'
  } else {
    push(`[data-fly="svc-${flight.svcName}"]`)
    if (flight.outcome === 'no-endpoints') fail = '503'
    else push(`[data-fly="${flight.nodeId}"]`)
  }

  const points = hops.filter(Boolean)
  if (points.length < 2) return null
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const outMs = REQ_HOP_S * (points.length - 1)

  return (
    <div className="chip-flight-layer">
      <motion.span
        className={'req-chip' + (fail ? ' fail' : '')}
        initial={{ x: xs[0], y: ys[0], opacity: 0 }}
        animate={{ x: xs, y: ys, opacity: [0, 1, 1] }}
        transition={{ duration: outMs, ease: 'linear', opacity: { duration: 0.2 } }}
      >
        GET /
      </motion.span>
      {fail ? (
        <motion.span
          className="req-chip fail"
          initial={{ x: xs[xs.length - 1], y: ys[ys.length - 1], opacity: 0, scale: 0.8 }}
          animate={{ opacity: [0, 1, 1, 0], scale: [0.8, 1.15, 1, 0.9], y: ys[ys.length - 1] - 16 }}
          transition={{ delay: outMs, duration: 0.9, times: [0, 0.2, 0.75, 1] }}
        >
          ✗ {fail}
        </motion.span>
      ) : (
        <motion.span
          className="req-chip ok"
          initial={{ x: xs[xs.length - 1], y: ys[ys.length - 1], opacity: 0 }}
          animate={{
            x: [xs[xs.length - 1], xs[0]],
            y: [ys[ys.length - 1], ys[0]],
            opacity: [0, 1, 1, 0],
          }}
          transition={{
            delay: outMs + 0.1,
            duration: REQ_HOP_S * 2,
            ease: 'easeInOut',
            times: [0, 0.15, 0.8, 1],
          }}
        >
          200 ✓
        </motion.span>
      )}
    </div>
  )
}
