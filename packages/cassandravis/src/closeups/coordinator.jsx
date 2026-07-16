import { motion } from 'framer-motion'
import { NODE_IDS, NODE_COLORS } from '../cluster'

// Close-up offered on the NEW coordinator during coordCrash's reroute step:
// the leader-vs-leaderless contrast. The stage has already shown the REAL
// failure (old coordinator DOWN, client rerouted); this zoom supplies the
// counterfactual — what the same crash would have cost in a leader-based
// store. `p` is the coordCrash payload: { node: dead coordinator, next: the
// peer the driver picked }.
export function build(p) {
  const steps = [
    {
      key: 'happened',
      title: '1 · What just happened on stage',
      blurb: `${p.node} — the node this client was talking to — died, and the client's driver simply opened a connection to ${p.next}. That one client-side act is the entire "selection of a new coordinator". No cluster machinery ran: ${p.next} wasn't promoted, told, or given anything; it's coordinating because it's being talked to.`,
    },
    {
      key: 'leader',
      title: '2 · The counterfactual: if this cluster had a LEADER',
      blurb: `A leader (primary/master) is a single node that OWNS all writes for a key range. Lose it, and the cluster must detect the loss, run a failover ELECTION among the followers, and promote one — and every write to those keys stalls until the new leader exists. That pause and that chokepoint are the price of having an owner. This is what the word "leader" means when the blurbs say Cassandra has none.`,
    },
    {
      key: 'leaderless',
      title: '3 · Here: nothing to elect',
      blurb: `${p.node} owned nothing exclusive — the N replicas of every key hold the data, and ANY live node can coordinate any request. So there is nothing to detect cluster-wide, nothing to elect, nothing to promote. The "new coordinator" is a per-request, client-side choice. (${p.node}'s own replica copies catch up later via hints and repair, like any crashed node.)`,
    },
    {
      key: 'verdict',
      title: '4 · That absence is "leaderless"',
      blurb: `Compare the two columns: same crash, but one side pauses writes for an election while the other never stops serving. No election, no write bottleneck, no single point whose death needs a succession plan — that is what "leaderless" buys, and why the coordinator was never a leader.`,
    },
  ]

  function Stage({ step }) {
    return (
      <div className="cu-rows">
        {/* the cluster as the stage just showed it: old coordinator dead, next coordinating */}
        <div className="cu-peers">
          {NODE_IDS.map((id) => {
            const dead = id === p.node
            const isCoord = id === p.next
            return (
              <span
                key={id}
                className={'cu-peer' + (dead ? ' down' : '') + (isCoord ? ' coord' : '')}
              >
                <span className="node-dot" style={{ background: NODE_COLORS[id] }} />
                {id}
                {isCoord && <span className="cu-peer-tag">coordinator</span>}
                {dead && <span className="cu-peer-tag down">✕ down</span>}
              </span>
            )
          })}
        </div>

        <div className="cu-wire">
          <span className="cu-peer">🧑‍💻 client</span>
          <span className="cu-arrow">→ requests →</span>
          <span className="cu-peer coord">
            <span className="node-dot" style={{ background: NODE_COLORS[p.next] }} />
            {p.next}
          </span>
          <span className="cu-note">
            (was {p.node} — the driver rerouted, nobody "elected" anything)
          </span>
        </div>

        <div className="cu-versus">
          <div className={'cu-col' + (step === 1 ? ' on' : step > 1 ? ' off' : '')}>
            <div className="cu-col-head">If {p.node} had been a LEADER</div>
            <div className="cu-col-body">
              {step >= 1 ? (
                <>
                  <div className="cu-mono">⚠ leader lost — writes to its keys stall</div>
                  <div className="cu-mono">↻ failover election among followers…</div>
                  <div className="cu-mono">promote one to new leader</div>
                  <div className="cu-mono bad">writes paused until it completes</div>
                </>
              ) : (
                <div className="cu-note">one node owns each key's writes</div>
              )}
            </div>
          </div>

          <div className={'cu-col' + (step >= 2 ? ' on' : '')}>
            <div className="cu-col-head">Leaderless (what you just watched)</div>
            <div className="cu-col-body">
              {step >= 2 ? (
                <>
                  <div className="cu-mono">nothing to elect — no owner existed</div>
                  <div className="cu-mono">driver opens a connection to {p.next}</div>
                  <div className="cu-mono">{p.next} coordinates, as any peer could</div>
                  <div className="cu-mono ok">no pause · replicas still hold the data</div>
                </>
              ) : (
                <div className="cu-note">any peer can coordinate any request</div>
              )}
            </div>
          </div>
        </div>

        {step >= 3 && (
          <motion.div className="cu-verdict ok" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            ✓ same crash, no election — the coordinator was never a leader
          </motion.div>
        )}
      </div>
    )
  }

  return {
    key: `coord-${p.node}-${p.next}`,
    title: `${p.node} died — why no election just happened`,
    sub: 'leader vs coordinator',
    source: `[data-fly="${p.next}"]`,
    steps,
    Stage,
  }
}
