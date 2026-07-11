import { motion } from 'framer-motion'
import { NODE_COLORS, NODE_IDS } from '../cluster'
import { fnv } from './shared'

const PHI_THRESHOLD = 8

// Close-up: one live peer's gossip table while another node dies — heartbeat
// counters, and the phi-accrual failure detector losing confidence.
export function build(peerId, deadId) {
  const others = NODE_IDS.filter((n) => n !== peerId)
  // Deterministic fake heartbeat counters (they only need to look plausible).
  const hb = (nid) => 4200 + (fnv(nid) % 900)

  const steps = [
    {
      key: 'table',
      title: `1 · ${peerId}'s gossip table`,
      blurb: 'Every second, each node gossips with a few random peers, exchanging (among other things) a heartbeat counter per node. Each node therefore keeps its OWN table of "when did I last hear a new heartbeat from X?" — there is no central health service to ask.',
    },
    {
      key: 'stall',
      title: `2 · ${deadId}'s counter stops advancing`,
      blurb: `Everyone else's counters keep ticking up as gossip spreads them. ${deadId}'s number is frozen — not an error message, not a disconnect event, just… silence where there used to be increments.`,
    },
    {
      key: 'phi',
      title: '3 · φ: "how surprising is this silence?"',
      blurb: `The phi-accrual detector doesn't use a fixed timeout. It learns each node's normal heartbeat rhythm and computes φ, a suspicion level that grows the longer the silence outlasts that rhythm. A slow network raises φ slowly; a dead node sends it climbing past the threshold (${PHI_THRESHOLD} here).`,
    },
    {
      key: 'down',
      title: `4 · ${peerId} convicts: ${deadId} is DOWN`,
      blurb: `φ crossed the threshold, so THIS peer marks ${deadId} DOWN — its own opinion, formed locally. Every other node runs the same detector and reaches the same verdict; the cluster's "DOWN" is that consensus of independent opinions, not an announcement.`,
    },
  ]

  function Stage({ step }) {
    return (
      <div className="cu-rows">
        <div className="cu-banner">
          <span className="node-dot" style={{ background: NODE_COLORS[peerId] }} />
          <span className="cu-cell">{peerId} · failure detector</span>
          <span className="cu-note">φ threshold = {PHI_THRESHOLD}</span>
        </div>

        {others.map((nid, i) => {
          const dead = nid === deadId
          const phi = dead ? (step >= 3 ? 9.2 : step >= 2 ? 6.4 : 0.4) : 0.3 + (fnv(nid) % 4) / 10
          const convicted = dead && step >= 3
          return (
            <motion.div
              key={nid}
              className={'cu-row' + (convicted ? ' bad' : '')}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: step === 0 ? i * 0.15 : 0 }}
            >
              <span className="node-dot" style={{ background: NODE_COLORS[nid] }} />
              <span className="cu-cell">{nid}</span>
              <span className="cu-cell mono">
                heartbeat: {hb(nid) + (dead ? 0 : step * 3)}
                {dead && step >= 1 ? ' (frozen)' : ' ↑'}
              </span>
              <span className="cu-phi">
                <span className="cu-phi-track">
                  <motion.span
                    className={'cu-phi-fill' + (phi > PHI_THRESHOLD ? ' over' : '')}
                    animate={{ width: `${Math.min(100, (phi / 10) * 100)}%` }}
                    transition={{ duration: 0.8 }}
                  />
                  <span className="cu-phi-mark" style={{ left: `${(PHI_THRESHOLD / 10) * 100}%` }} />
                </span>
                <span className="cu-cell mono dim">φ {phi.toFixed(1)}</span>
              </span>
              <span className="cu-cell right">{convicted ? '✕ DOWN' : step >= 2 && dead ? 'suspect…' : 'UP'}</span>
            </motion.div>
          )
        })}

        {step >= 3 && (
          <motion.div className="cu-verdict bad" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            ✕ {deadId} marked DOWN by {peerId} — no failover, no election; writes it misses become
            hints
          </motion.div>
        )}
      </div>
    )
  }

  return {
    key: `gossip-${peerId}-${deadId}`,
    title: `${peerId} · gossip & the φ failure detector`,
    sub: `${peerId} · failure detection`,
    source: `[data-fly="${peerId}"]`,
    steps,
    Stage,
  }
}
