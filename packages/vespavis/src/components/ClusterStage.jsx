import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { MODES } from '../ranking'
import { FLUSH_MAXMEMORYGAIN } from '../constants'
import {
  bucketLabel,
  bucketsOn,
  CONTAINER_NODES,
  CONTENT_NODES,
  ENTRY_CONTAINER,
  REDUNDANCY,
} from '../cluster'

// The centre stage. Two tiers, because that split IS Vespa's architecture: a
// stateless container cluster that prepares queries, merges results and runs the
// last ranking phase, and a stateful content cluster that stores everything and
// does the matching. They are drawn as separate boxes because they scale as
// separate boxes.
//
// A content node's BODY is the ranking funnel, not its storage. That is the
// deliberate choice this stage is built around: Vespa's distinguishing work is
// the progressive narrowing of a candidate set through phases that are each
// allowed to cost more than the last, and the picture should be the shape of
// that narrowing. Storage is real and is one click away; it is not the subject.
export default function ClusterStage({ cluster, extra, op }) {
  const type = op?.type
  const feed = extra.feed
  const upd = extra.update
  const rm = extra.remove
  const search = extra.search
  const at = extra.at || {}

  const activeNodes = new Set()
  if (type === 'feed' && feed?.routed) for (const n of feed.replicas) activeNodes.add(n)
  if (type === 'update' && upd?.routed) for (const n of upd.replicas) activeNodes.add(n)
  if (type === 'remove' && rm) for (const n of rm.replicas) activeNodes.add(n)
  if (type === 'flush') for (const n of extra.flush?.nodes || []) activeNodes.add(n)
  if (type === 'fusion') for (const n of extra.fusion?.nodes || []) activeNodes.add(n)
  if (type === 'query' && at.dispatch && !at.merge)
    for (const n of CONTENT_NODES) activeNodes.add(n.id)
  // The user fetch touches exactly one node — the active replica of the user
  // document's bucket — and nothing else. Showing that one node light up on its
  // own is the cheapest way to say "this is a get by id, not a search".
  if (type === 'query' && at.fetchUser && !at.dispatch && extra.userNode != null)
    activeNodes.add(extra.userNode)

  const containerBusy =
    (type === 'query' && (at.fetchUser || at.parse || at.merge)) ||
    (type === 'feed' && feed && !feed.routed) ||
    type === 'update'

  const highlightDoc = feed?.doc?.id || upd?.id || rm?.id || null
  const highlightBucket = feed?.bucket ?? upd?.bucket ?? rm?.bucket ?? null

  return (
    <div className="cluster">
      <section className={'tier container-tier' + (containerBusy ? ' busy' : '')}>
        <div className="tier-head">
          <span className="tier-name">Stateless container cluster</span>
          <span className="tier-sub">query prep · merge · global-phase · summaries</span>
        </div>
        <div className="container-row" data-container-target>
          {CONTAINER_NODES.map((c) => (
            <div
              key={c.id}
              className={
                'container-node' +
                (c.id === ENTRY_CONTAINER && containerBusy ? ' active' : '')
              }
            >
              <span className="cn-name">{c.name}</span>
              {c.id === ENTRY_CONTAINER && <span className="badge">entry</span>}
            </div>
          ))}
        </div>
        <ContainerWork type={type} at={at} search={search} feed={feed} extra={extra} />
      </section>

      <div className={'tier-wire' + (activeNodes.size ? ' live' : '')}>
        <span className="wire-label">
          {type === 'query'
            ? at.fill
              ? 'summary fill'
              : at.merge
              ? 'top hits · ids + scores only'
              : at.dispatch
              ? 'dispatch — every content node'
              : at.fetchUser
              ? 'get user document by id'
              : ''
            : type
            ? 'document operation'
            : ''}
        </span>
      </div>

      <section className="tier content-tier">
        <div className="tier-head">
          <span className="tier-name">Content cluster</span>
          <span className="tier-sub">
            {CONTENT_NODES.length} nodes · min-redundancy {REDUNDANCY} · distributor + proton
          </span>
        </div>
        <div className="content-row">
          {cluster.nodes.map((node) => (
            <ContentNode
              key={node.id}
              node={node}
              docs={cluster.docs}
              active={activeNodes.has(node.id)}
              highlightDoc={highlightDoc}
              highlightBucket={highlightBucket}
              op={op}
              at={at}
              search={search}
              extra={extra}
            />
          ))}
        </div>
      </section>

      <section className="tier admin-tier">
        <span className="tier-name">Admin &amp; config cluster</span>
        <span className="admin-item">config server</span>
        <span className="admin-item">cluster controller</span>
        <span className="admin-item">slobrok</span>
        <span className="tier-sub">
          holds the application package and the cluster state; never on the query path
        </span>
      </section>
    </div>
  )
}

// What the stateless tier is doing right now. A query touches the container at
// both ends — and the second visit is where the expensive model runs — so each
// container-side phase gets its own visible slot rather than being implied by a
// border colour.
function ContainerWork({ type, at, search, feed, extra }) {
  const items = []
  if (type === 'query' && search) {
    const m = MODES[search.mode]
    if (m.usesProfile)
      items.push({
        k: 'fetchUser',
        on: at.fetchUser,
        label: 'get user',
        detail: at.fetchUser ? `${extra.userName} · profile tensor` : '—',
      })
    items.push({
      k: 'parse',
      on: at.parse,
      label: m.usesProfile ? 'build query' : 'parse + embed',
      detail: m.usesProfile
        ? 'nearestNeighbor(embedding, user_profile)'
        : search.terms.length
        ? `${search.terms.length} terms${search.queryVector ? ' + query tensor' : ''}`
        : search.queryVector
        ? 'query tensor'
        : 'nothing to match',
    })
    items.push({
      k: 'merge',
      on: at.merge,
      label: 'merge',
      detail: at.merge
        ? `${search.merged.length} hits from ${Object.keys(search.perNode).length} nodes`
        : '—',
    })
    // Only for a profile that DECLARES a global-phase. A slot that appears and
    // says "rerank 0" claims the phase ran and found nothing to do, when the
    // truth is that this profile does not have one.
    if (m.globalPhase)
      items.push({
        k: 'global',
        on: at.global,
        label: 'global-phase',
        detail: at.global ? `rerank ${search.globalReranked}` : '—',
      })
    items.push({
      k: 'fill',
      on: at.fill,
      label: 'summary fill',
      detail: at.fill ? `${search.final.length} documents` : '—',
    })
  } else if (type === 'feed' && feed) {
    items.push({
      k: 'chain',
      on: true,
      label: 'indexing chain',
      detail: feed.processed ? 'analyzed + embedded' : 'received',
    })
  }
  if (!items.length) return null
  return (
    <div className="container-work">
      {items.map((i) => (
        <div key={i.k} className={'cw-slot' + (i.on ? ' on' : '')}>
          <span className="cw-label">{i.label}</span>
          <span className="cw-detail">{i.detail}</span>
        </div>
      ))}
    </div>
  )
}

function ContentNode({ node, docs, active, highlightDoc, highlightBucket, op, at, search, extra }) {
  const [openStore, setOpenStore] = useState(false)
  const buckets = bucketsOn(node.id)
  const stats = search?.perNode?.[node.id]
  const type = op?.type
  const m = search ? MODES[search.mode] : null

  const activeBuckets = new Set(buckets.filter((b) => b.active).map((b) => b.bucket))
  const matchedIds = new Set(
    type === 'query' && at.match ? (stats?.scored || []).map((h) => h.id) : [],
  )
  const returnedIds = new Set(
    type === 'query' && at.merge ? (stats?.returned || []).map((h) => h.id) : [],
  )

  return (
    <div className={'cnode' + (active ? ' active' : '')} data-node-target={node.id}>
      <div className="cnode-head">
        <span className="cnode-name">{node.name}</span>
        <span className="badge dist">distributor</span>
      </div>

      <div
        className="bucket-strip"
        title="Buckets this node stores. Filled = it is the active replica, and only the active replica may answer for a bucket."
      >
        {buckets.map((b) => (
          <span
            key={b.bucket}
            className={
              'bucket' +
              (b.active ? ' on' : '') +
              (highlightBucket === b.bucket ? ' target' : '')
            }
          >
            {bucketLabel(b.bucket)}
          </span>
        ))}
        {buckets.length === 0 && <span className="bucket empty">no buckets</span>}
      </div>

      {/* ---- the funnel: the node's actual work ---- */}
      {type === 'query' && stats ? (
        <Funnel stats={stats} at={at} mode={m} />
      ) : (
        <IdleBody node={node} docs={docs} activeBuckets={activeBuckets} />
      )}

      <StoreToggle
        node={node}
        open={openStore}
        onToggle={() => setOpenStore((o) => !o)}
        flushing={op?.type === 'flush' && extra.flush?.nodes?.includes(node.id)}
      />

      <AnimatePresence initial={false}>
        {openStore && (
          <motion.div
            className="store-panel"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22 }}
          >
            <Storage
              node={node}
              docs={docs}
              activeBuckets={activeBuckets}
              highlightDoc={highlightDoc}
              matchedIds={matchedIds}
              returnedIds={returnedIds}
              op={op}
              extra={extra}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// The whole reason this app exists, drawn as a shape.
//
// Each bar is a phase, scaled against the documents the node was ACTIVE for, so
// the narrowing is honest and comparable between nodes. Read down the stack and
// you read the cost model: every phase sees fewer documents than the one above
// it, which is exactly what buys the right to run a more expensive expression.
function Funnel({ stats, at, mode }) {
  const total = Math.max(1, stats.readyCount)
  const rows = [
    { k: 'active', label: 'active docs', v: stats.readyCount, on: true, tone: 'base' },
    { k: 'match', label: 'matched', v: stats.matched, on: at.match, tone: 'match' },
    { k: 'first', label: 'first-phase', v: stats.matched, on: at.first, tone: 'first' },
  ]
  if (mode?.secondPhase)
    rows.push({
      k: 'second',
      label: 'second-phase',
      v: stats.reranked,
      on: at.second,
      tone: 'second',
    })
  // NOTE the funnel is not always monotonic, and that is correct rather than a
  // rendering fault: `returned` can exceed `second-phase`, because second-phase
  // REORDERS the head and does not truncate the tail. The caption below says so
  // whenever it happens, so the shape reads as information instead of a bug.
  rows.push({
    k: 'returned',
    label: 'returned',
    v: stats.returned.length,
    on: at.merge,
    tone: 'returned',
  })

  return (
    <div className="funnel">
      {rows.map((r) => (
        <div key={r.k} className={'fn-row' + (r.on ? ' on' : '')}>
          <span className="fn-label">{r.label}</span>
          <span className="fn-track">
            <motion.span
              className={'fn-bar fn-' + r.tone}
              initial={false}
              animate={{ width: r.on ? `${(r.v / total) * 100}%` : '0%' }}
              transition={{ type: 'spring', stiffness: 200, damping: 26 }}
            />
          </span>
          <span className="fn-value">{r.on ? r.v : '·'}</span>
        </div>
      ))}
      {at.merge && stats.reranked > 0 && stats.returned.length > stats.reranked && (
        <div className="fn-note">
          second-phase re-scored the top {stats.reranked}; the other{' '}
          {stats.returned.length - stats.reranked} kept the first-phase score and
          came back anyway
        </div>
      )}
      {stats.filteredOut > 0 && at.match && (
        <div className="fn-note">
          {stats.filteredOut} excluded by the filter <i>before</i> the walk
        </div>
      )}
      {stats.postFilterDropped > 0 && at.match && (
        <div className="fn-note warn">
          {stats.postFilterDropped}{' '}
          {stats.postFilterDropped === 1 ? 'neighbour' : 'neighbours'} found, then
          thrown away by the filter
        </div>
      )}
    </div>
  )
}

// With no query running there is no funnel to draw, so the body says what the
// node holds instead — still counted the way a query would count it.
function IdleBody({ node, docs, activeBuckets }) {
  const products = node.ready.filter(
    (id) => docs[id]?.type === 'product' && activeBuckets.has(docs[id].bucket),
  )
  const users = node.ready.filter(
    (id) => docs[id]?.type === 'user' && activeBuckets.has(docs[id].bucket),
  )
  const passive = node.ready.length - products.length - users.length
  return (
    <div className="idle-body">
      <div className="ib-row">
        <span>active products</span>
        <b>{products.length}</b>
      </div>
      <div className="ib-row">
        <span>active users</span>
        <b>{users.length}</b>
      </div>
      <div className="ib-row muted" title="Stored and indexed here, but another node is the active replica of their bucket, so this node must not answer for them.">
        <span>standby copies</span>
        <b>{passive}</b>
      </div>
    </div>
  )
}

// The flush strategy, as a gauge rather than a button.
//
// Proton's flush engine runs a flush when the memory index has grown past its
// budget (`maxmemorygain` — a byte figure; documents here). Nobody presses
// anything, so nothing here is pressable: the bar fills as you feed, and when
// it crosses, a flush starts on its own.
function StoreToggle({ node, open, onToggle, flushing }) {
  const pct = Math.min(100, (node.memoryIndex.length / FLUSH_MAXMEMORYGAIN) * 100)
  return (
    <div className="store-toggle-row">
      <button className={'store-toggle' + (open ? ' open' : '')} onClick={onToggle}>
        <span className="chev">{open ? '▾' : '▸'}</span> storage
        <span className="st-meta">
          {node.diskIndexes.length} idx · {node.ready.length} rows
        </span>
      </button>
      <div
        className={'flush-gauge' + (flushing ? ' firing' : '')}
        title={`Memory index: ${node.memoryIndex.length} / ${FLUSH_MAXMEMORYGAIN} documents. Proton's flush engine flushes by itself when this fills.`}
      >
        <span className="fg-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function Storage({ node, docs, activeBuckets, highlightDoc, matchedIds, returnedIds, op, extra }) {
  return (
    <div className="subdb">
      <div className="subdb-head">
        <span className="subdb-name">Ready</span>
        <span className="subdb-count">{node.ready.length}</span>
      </div>

      <div className={'store mem' + (node.memoryIndex.length ? '' : ' empty')}>
        <div className="store-head">
          memory index
          {op?.type === 'flush' && extra.flush?.nodes?.includes(node.id) && (
            <span className="store-flag">flushing…</span>
          )}
        </div>
        <div className="chip-row">
          {node.memoryIndex.map((id) => (
            <DocChip
              key={id}
              id={id}
              docs={docs}
              activeBuckets={activeBuckets}
              highlight={highlightDoc === id}
              matched={matchedIds.has(id)}
              returned={returnedIds.has(id)}
            />
          ))}
          {!node.memoryIndex.length && <span className="chip-empty">empty</span>}
        </div>
      </div>

      <AnimatePresence mode="popLayout">
        {node.diskIndexes.map((idx) => (
          <motion.div
            key={idx.id}
            layout
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ type: 'spring', stiffness: 260, damping: 24 }}
            className={'store disk' + (idx.fresh ? ' fresh' : '')}
          >
            <div className="store-head">
              <span className="lock">🔒</span>
              {idx.id}
            </div>
            <div className="chip-row">
              {idx.docIds.map((id) => (
                <DocChip
                  key={id}
                  id={id}
                  docs={docs}
                  activeBuckets={activeBuckets}
                  highlight={highlightDoc === id}
                  matched={matchedIds.has(id)}
                  returned={returnedIds.has(id)}
                />
              ))}
            </div>
          </motion.div>
        ))}
      </AnimatePresence>

      {/* Attributes are not partitioned into indexes. Every ready document has
          its attribute values in memory from the moment it is written, which is
          the entire reason an attribute update is one assignment. */}
      <div className="attr-line">
        attributes · in memory · {node.ready.length} rows · every field live
      </div>

      <div className="chip-row user-row">
        {node.ready
          .filter((id) => docs[id]?.type === 'user')
          .map((id) => (
            <DocChip
              key={id}
              id={id}
              docs={docs}
              activeBuckets={activeBuckets}
              highlight={highlightDoc === id}
            />
          ))}
      </div>

      <div className="subdb-foot">
        <span title="Stored but not indexed. Only populated when searchable-copies is lower than redundancy.">
          Not Ready {node.notReady.length}
        </span>
        <span
          className={node.removed.length ? 'has-tombstones' : ''}
          title="Tombstones: id + timestamp, kept so a bucket merge between replicas cannot resurrect a removed document."
        >
          Removed {node.removed.length}
        </span>
        <span title="The durability log. Pruned up to the last flushed serial number.">
          translog {node.translog.length}
        </span>
      </div>
    </div>
  )
}

// One document, as this node holds it. The `passive` state is the one worth
// looking for: the node stores the document, it is fully indexed, and it still
// must not return it — because another node is the active replica of its bucket.
// That is the difference between redundancy and duplicate results.
function DocChip({ id, docs, activeBuckets, highlight, matched, returned }) {
  const d = docs[id]
  if (!d) return null
  const passive = !activeBuckets.has(d.bucket)
  const isUser = d.type === 'user'
  return (
    <motion.span
      layout
      className={
        'doc-chip' +
        (isUser ? ' user' : '') +
        (passive ? ' passive' : '') +
        (d.removed ? ' removed' : '') +
        (highlight ? ' highlight' : '') +
        (returned ? ' returned' : matched ? ' matched' : '')
      }
      style={isUser ? undefined : { background: d.color }}
      title={
        isUser
          ? `user ${d.user_id} — profile tensor, no index${
              passive ? ' (this node is NOT the active replica)' : ''
            }`
          : `${d.title} — ${d.category} · bucket ${bucketLabel(d.bucket)}${
              passive ? ' (this node is NOT the active replica)' : ''
            }`
      }
    >
      {isUser ? `@${d.user_id}` : `#${d.n}`}
    </motion.span>
  )
}
