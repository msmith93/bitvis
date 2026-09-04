import { motion } from 'framer-motion'
import { angleOf, TOPIC_ARCS } from '../vectors'
import { CATEGORY_COLOR } from '../schema'

// The vector space, drawn.
//
// Vespa's embeddings are 384 to 1536 dimensions of nothing a human can read,
// which is why every explanation of vector search is a metaphor. This app's
// model is two-dimensional ON PURPOSE (see vectors.js), and this panel is why:
// the entire space fits on a circle, so "these two documents are close" stops
// being a claim and becomes something you can look at.
//
// Everything here is read off the same vectors the ranking model scores. There
// is no separate layout, no projection, no t-SNE — the angle a dot sits at IS
// the angle `angularDistance` measures.
// Geometry sized so the topic LABELS sit inside the viewBox, not just the
// circle. The labels are anchored end/start and hang outward from their point,
// so the box has to be wider than it is tall — sizing it to the circle clipped
// "electronics" and "footwear" at every column width.
const R = 100
const CX = 185
const CY = 150
const VW = 370
const VH = 300

const pt = (deg, r = R) => {
  const a = (deg * Math.PI) / 180
  return { x: CX + r * Math.cos(a), y: CY - r * Math.sin(a) }
}

export default function VectorSpace({ docs, search, profile, profileLabel, targetHits }) {
  const products = Object.values(docs).filter((d) => d.type === 'product' && d.embedding)

  // Which documents the vector half of this query actually returned. Ringed, so
  // "targetHits per node" is visible as a set on the circle rather than a number
  // in a table.
  const neighbours = new Set()
  if (search)
    for (const p of Object.values(search.perNode))
      for (const h of p.scored) if (h.via?.ann) neighbours.add(h.id)

  const queryVec = search?.queryVector
  const profileDeg = profile ? angleOf(profile) : null
  // In a recommendation the query vector IS the profile, so drawing both would
  // put two arrows on one line and invite the reader to look for a difference
  // that does not exist. The profile is the more informative label of the two.
  const sameAsProfile =
    !!queryVec && !!profile && queryVec[0] === profile[0] && queryVec[1] === profile[1]
  const queryDeg = queryVec && !sameAsProfile ? angleOf(queryVec) : null

  return (
    <div className="vspace">
      <svg
        viewBox={`0 0 ${VW} ${VH}`}
        className="vs-svg"
        role="img"
        aria-label="vector space"
      >
        {/* topic arcs — the lexicon's four directions */}
        {TOPIC_ARCS.map((t) => {
          const p = pt(t.deg, R + 22)
          return (
            <g key={t.label}>
              <line
                x1={CX}
                y1={CY}
                x2={pt(t.deg).x}
                y2={pt(t.deg).y}
                className="vs-spoke"
              />
              <text
                x={p.x}
                y={p.y}
                className="vs-topic"
                textAnchor={p.x < CX - 4 ? 'end' : p.x > CX + 4 ? 'start' : 'middle'}
                dominantBaseline="middle"
              >
                {t.label}
              </text>
            </g>
          )
        })}

        <circle cx={CX} cy={CY} r={R} className="vs-ring" />

        {/* every product, at the angle its pooled embedding points */}
        {products.map((d) => {
          const deg = angleOf(d.embedding)
          const p = pt(deg)
          const hit = neighbours.has(d.id)
          return (
            <g key={d.id}>
              {hit && <circle cx={p.x} cy={p.y} r={7} className="vs-halo" />}
              <circle
                cx={p.x}
                cy={p.y}
                r={hit ? 4.5 : 3.5}
                fill={CATEGORY_COLOR[d.category]}
                className={'vs-dot' + (hit ? ' hit' : '')}
              >
                <title>{`${d.title} — ${d.category} · ${deg.toFixed(0)}°`}</title>
              </circle>
            </g>
          )
        })}

        {/* the query vector */}
        {queryDeg !== null && (
          <motion.line
            x1={CX}
            y1={CY}
            x2={pt(queryDeg, R + 6).x}
            y2={pt(queryDeg, R + 6).y}
            className="vs-query"
            initial={false}
            animate={{
              x2: pt(queryDeg, R + 6).x,
              y2: pt(queryDeg, R + 6).y,
            }}
            transition={{ type: 'spring', stiffness: 120, damping: 20 }}
          />
        )}

        {/* the user profile — the one arrow that MOVES, which is the point */}
        {profileDeg !== null && (
          <motion.line
            x1={CX}
            y1={CY}
            x2={pt(profileDeg, R + 6).x}
            y2={pt(profileDeg, R + 6).y}
            className="vs-profile"
            initial={false}
            animate={{
              x2: pt(profileDeg, R + 6).x,
              y2: pt(profileDeg, R + 6).y,
            }}
            transition={{ type: 'spring', stiffness: 90, damping: 18 }}
          />
        )}

        <circle cx={CX} cy={CY} r={2.5} className="vs-origin" />
      </svg>

      <div className="vs-legend">
        {queryDeg !== null && (
          <div className="vs-key">
            <span className="vs-swatch query" /> query tensor
            <i>{queryDeg.toFixed(0)}°</i>
          </div>
        )}
        {profileDeg !== null && (
          <div className="vs-key">
            <span className="vs-swatch profile" /> {profileLabel || 'user'} profile
            <i>{profileDeg.toFixed(0)}°</i>
          </div>
        )}
        {neighbours.size > 0 && (
          <div className="vs-key">
            <span className="vs-swatch ring" /> returned by nearestNeighbor
            <i>{neighbours.size} of {products.length}</i>
          </div>
        )}
      </div>

      <p className="vs-note">
        Two dimensions, so the whole space fits here. Real embeddings have
        hundreds — the geometry is the same, you just cannot look at it.
        {targetHits ? (
          <>
            {' '}
            <code>targetHits: {targetHits}</code> is per content node, which is
            why more than {targetHits} documents can come back ringed.
          </>
        ) : null}
      </p>
    </div>
  )
}
