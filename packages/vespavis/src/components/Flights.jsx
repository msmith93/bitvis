import { useEffect, useState } from 'react'
import FlyingTokens, { selectorRect } from './tokenFlight'
import { CONTENT_NODES } from '../cluster'
import { GATHER_LEAD_MS } from '../timing'

// The chips that cross the wire, and — just as importantly — WHAT they are.
//
// The single most misread thing about a distributed query is what actually
// travels. On dispatch it is the query. On the way back it is ids and floats,
// which is why the chips are bare ids with no colour. Only in the summary fill
// does a document travel, and those chips carry the document's colour. If the
// two return trips looked the same there would be no reason for a second
// protocol phase to exist, and the picture would be lying.
export default function Flights({ op, extra }) {
  const [rects, setRects] = useState(null)
  const type = op?.type
  const phase = extra.phase
  const step = op?.step ?? -1

  // Rects are read AFTER the render that changed the step, so the DOM is at
  // rest and the layout is the one the chips will actually fly across.
  useEffect(() => {
    const id = requestAnimationFrame(() =>
      setRects({
        container: selectorRect('[data-container-target]'),
        nodes: Object.fromEntries(
          CONTENT_NODES.map((n) => [n.id, selectorRect(`[data-node-target="${n.id}"]`)]),
        ),
      }),
    )
    return () => cancelAnimationFrame(id)
  }, [type, step, phase])

  if (!rects || !rects.container) return null
  const search = extra.search

  // ---- Query: dispatch --------------------------------------------------
  if (type === 'query' && phase === 'dispatch')
    return (
      <>
        {CONTENT_NODES.map((n) => (
          <FlyingTokens
            key={'d' + n.id + step}
            tokens={[{ id: `q-${n.id}`, term: 'query' }]}
            from={rects.container}
            to={rects.nodes[n.id]}
            variant="request"
          />
        ))}
      </>
    )

  // ---- Query: the hits come back as ids + scores -------------------------
  if (type === 'query' && phase === 'merge' && search)
    return (
      <>
        {CONTENT_NODES.map((n) => {
          const hits = search.perNode[n.id]?.returned || []
          if (!hits.length) return null
          return (
            <FlyingTokens
              key={'g' + n.id + step}
              tokens={hits.map((h) => ({ id: `${n.id}-${h.id}`, term: `#${h.id.split('::')[1]}` }))}
              from={rects.nodes[n.id]}
              to={rects.container}
              variant="request"
              delayMs={GATHER_LEAD_MS}
            />
          )
        })}
      </>
    )

  // ---- Query: only now does a document travel ---------------------------
  if (type === 'query' && phase === 'fill' && search)
    return (
      <>
        {Object.entries(search.fillByNode).map(([nodeId, ids]) => (
          <FlyingTokens
            key={'f' + nodeId + step}
            tokens={ids.map((id) => ({
              id: `${nodeId}-fill-${id}`,
              term: 'summary',
              color: undefined,
            }))}
            from={rects.nodes[nodeId]}
            to={rects.container}
            delayMs={GATHER_LEAD_MS}
          />
        ))}
      </>
    )

  // ---- Feed: the INDEXED form leaves the container ----------------------
  // Vespa analyzes and embeds ONCE, in the container's indexing chain, and
  // ships the result to every replica. What flies here is therefore the
  // finished terms and tensor, not the raw document for each node to process
  // again — which is why an expensive embedding model costs the cluster one
  // inference per document rather than one per copy.
  if (type === 'feed' && extra.feed?.routed) {
    const doc = extra.feed.doc
    const terms = [
      ...(doc.terms?.title || []),
      ...(doc.terms?.description || []),
    ].slice(0, 10)
    return (
      <>
        {extra.feed.replicas.map((n) => (
          <FlyingTokens
            key={'feed' + n + step}
            tokens={terms.map((t, i) => ({ id: `${n}-${i}-${t}`, term: t, color: doc.color }))}
            from={rects.container}
            to={rects.nodes[n]}
          />
        ))}
      </>
    )
  }

  return null
}
