import { motion, AnimatePresence } from 'framer-motion'
import { RING_SIZE, NODE_COLORS, ringTokens } from '../cluster'
import { RING_WALK_STEP_MS } from '../timing'

const CX = 150
const CY = 132
const R = 96

// Angle for a ring position: token 0 at 12 o'clock, clockwise.
const angle = (token) => (token / RING_SIZE) * Math.PI * 2 - Math.PI / 2
const pt = (token, r = R) => ({
  x: CX + Math.cos(angle(token)) * r,
  y: CY + Math.sin(angle(token)) * r,
})

// The consistent-hashing ring: a circle with one tick per vnode token (colored
// by physical node), the active key's hash marker, and the animated clockwise
// replica walk. `walkState` is opExtra's `ring`: { token, walk, walking,
// settled } — the walk is precomputed by replicaWalk() in cluster.js, so this
// component animates exactly what the placement function computed.
export default function Ring({ cluster, walkState }) {
  const ring = ringTokens(cluster)
  const marker = walkState ? pt(walkState.token, R) : null

  // Reveal walk stops one at a time while walking; all at once once settled.
  const stopDelay = (i) => (walkState?.walking ? i * (RING_WALK_STEP_MS / 1000) : 0)
  const visibleStops = walkState?.walking || walkState?.settled ? walkState.walk : []

  return (
    <div className="ring-wrap">
      <svg viewBox="0 0 300 264" className="ring-svg">
        {/* the ring itself */}
        <circle cx={CX} cy={CY} r={R} className="ring-circle" />

        {/* ownership arcs: each vnode owns (prevToken, token], drawn slightly
            inside the ring in the owner's color */}
        {ring.map((t, i) => {
          const prev = ring[(i - 1 + ring.length) % ring.length]
          const a0 = angle(prev.token)
          const a1 = angle(t.token) + (t.token <= prev.token ? Math.PI * 2 : 0)
          const r = R - 7
          const large = a1 - a0 > Math.PI ? 1 : 0
          const p0 = { x: CX + Math.cos(a0) * r, y: CY + Math.sin(a0) * r }
          const p1 = { x: CX + Math.cos(a1) * r, y: CY + Math.sin(a1) * r }
          const down = !cluster.nodes[t.node]?.up
          return (
            <path
              key={`arc-${t.token}`}
              d={`M ${p0.x} ${p0.y} A ${r} ${r} 0 ${large} 1 ${p1.x} ${p1.y}`}
              className="ring-arc"
              style={{ stroke: NODE_COLORS[t.node], opacity: down ? 0.15 : 0.45 }}
            />
          )
        })}

        {/* vnode ticks + token labels */}
        {ring.map((t) => {
          const p = pt(t.token)
          const lp = pt(t.token, R + 15)
          const down = !cluster.nodes[t.node]?.up
          return (
            <g key={`tick-${t.token}`} style={{ opacity: down ? 0.35 : 1 }}>
              <circle cx={p.x} cy={p.y} r={6.5} fill={NODE_COLORS[t.node]} className="ring-tick" />
              <text x={lp.x} y={lp.y} className="ring-token-label">
                {t.token}
              </text>
              {down && (
                <text x={p.x} y={p.y + 3.5} className="ring-tick-x">
                  ✕
                </text>
              )}
            </g>
          )
        })}

        {/* the key's hash marker */}
        <AnimatePresence>
          {marker && (
            <motion.g
              key={`marker-${walkState.token}`}
              initial={{ opacity: 0, scale: 0.4 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
            >
              <circle cx={marker.x} cy={marker.y} r={10.5} className="ring-marker-halo" />
              <path
                d={`M ${marker.x} ${marker.y - 22} L ${marker.x - 5} ${marker.y - 32} L ${marker.x + 5} ${marker.y - 32} Z`}
                className="ring-marker-pin"
              />
              <text x={marker.x} y={marker.y - 36} className="ring-marker-label">
                token {walkState.token}
              </text>
            </motion.g>
          )}
        </AnimatePresence>

        {/* the replica walk: sequential highlights clockwise from the marker;
            a skipped stop (vnode of an already-chosen node) gets a ✕ */}
        <AnimatePresence>
          {visibleStops.map((stop, i) => {
            const p = pt(stop.token)
            return (
              <motion.g
                key={`walk-${stop.token}-${i}`}
                initial={{ opacity: 0, scale: 0.4 }}
                animate={{ opacity: walkState.settled && !stop.taken ? 0.55 : 1, scale: 1 }}
                exit={{ opacity: 0 }}
                transition={{ delay: stopDelay(i), duration: 0.25 }}
              >
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={11}
                  className={stop.taken ? 'ring-walk-stop taken' : 'ring-walk-stop skipped'}
                  style={stop.taken ? { stroke: NODE_COLORS[stop.node] } : undefined}
                />
                <text x={p.x + 14} y={p.y - 10} className={'ring-walk-note' + (stop.taken ? ' taken' : '')}>
                  {stop.taken ? `R${walkState.walk.slice(0, i + 1).filter((s) => s.taken).length}` : 'skip'}
                </text>
              </motion.g>
            )
          })}
        </AnimatePresence>

        <text x={CX} y={CY - 6} className="ring-center-label">
          token ring
        </text>
        <text x={CX} y={CY + 10} className="ring-center-sub">
          0–{RING_SIZE - 1}
        </text>
      </svg>
    </div>
  )
}
