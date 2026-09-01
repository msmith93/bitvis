import { motion } from 'framer-motion'
import { shardInvertedIndex } from '../invertedIndex'

// Per-shard inverted indexes (term → doc ids) over each shard's SEARCHABLE
// segments. Each shard has its own index; a search unions them at query time.
// (Replica copies hold an identical index, so we show the primary's view.)
export default function InvertedIndexTable({ cluster }) {
  const hasDeleted = Object.values(cluster.docs).some((d) => d.deleted)
  return (
    <div>
      <p className="section-title">Inverted index — per shard</p>
      <div className="ii-meta">
        Each shard indexes only its own documents. A search unions these across
        all shards.
        {hasDeleted && (
          <>
            {' '}
            <span className="ii-strike-note">
              Struck-through postings are deleted docs, still physically in their
              segment until a merge reclaims them.
            </span>
          </>
        )}
      </div>

      {cluster.shards.map((shard) => {
        // `includePurged`: a delete a refresh has applied still has its posting
        // entries on disk until the next merge — shown struck through, the same
        // as it still shows in its segment on the cluster stage.
        const rows = shardInvertedIndex(shard, cluster.docs, { includePurged: true })
        return (
          <div className="shard-ii" key={shard.id}>
            <div className="shard-ii-head">shard {shard.id}</div>
            {rows.length === 0 ? (
              <div className="empty-note small">nothing searchable yet</div>
            ) : (
              <table className="ii">
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.term}>
                      <td className="term">{row.term}</td>
                      <td>
                        {row.docIds.map((id) => (
                          <motion.span
                            key={id}
                            layout
                            initial={{ opacity: 0, scale: 0.6 }}
                            animate={{ opacity: 1, scale: 1 }}
                            className={
                              'posting' + (cluster.docs[id]?.deleted ? ' deleted' : '')
                            }
                            style={{ background: cluster.docs[id]?.color || '#888' }}
                            title={
                              cluster.docs[id]?.purged
                                ? 'deleted — dropped from search on refresh; reclaimed at the next merge'
                                : cluster.docs[id]?.deleted
                                ? 'deleted — still searchable until the next refresh'
                                : undefined
                            }
                          >
                            {id}
                          </motion.span>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )
      })}
    </div>
  )
}
