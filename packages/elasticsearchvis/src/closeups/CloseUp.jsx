import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import Stepper from '../components/Stepper'
import DocLinks from '../components/DocLinks'
import { rectCenter, selectorRect } from '../components/tokenFlight'
import { INSPECTOR_DWELL_MS } from '../timing'

// The generic zoom-in overlay. Every close-up — a shard's local search, the
// coordinator's merge, a segment's on-disk term dictionary — is a
// `{ key, title, sub, steps, Stage, stageProps }` ctx built by a module in
// ./stages and dispatched by ./index.js. This shell contributes the backdrop,
// the head with its ✕, the explain box, the mini-stepper with its auto-play
// clock, and the entrance spring out of the element the user clicked.
//
// Close-ups NEST: the stack is rendered bottom-to-top, each in its own
// backdrop, so a zoom opened from inside a zoom springs out of its parent and
// closing it returns the parent to the exact step it was left on. Only the top
// of the stack is `active` — it alone runs an auto-play clock, and stages read
// `active` to park their own timers (the dictionary probe replay) while a child
// is covering them.
//
// Deliberately NO AnimatePresence exit: stages use framer `layout` chips, and
// an animated exit around relayouted chips can deadlock removal, leaving an
// invisible backdrop that swallows every click (this app hit exactly that in
// the old CoordinatorInspector). Closing unmounts instantly instead; App's
// `.layout` zoom-back covers the transition.
export default function CloseUp({
  stack,
  onPop,
  openCloseUp,
  highlightClose,
  held,
  quiet,
  onPanelStep,
  advance,
}) {
  if (!stack?.length) return null
  return stack.map((ctx, i) => (
    <Panel
      key={ctx.key}
      ctx={ctx}
      depth={i}
      active={i === stack.length - 1}
      openCloseUp={openCloseUp}
      held={held}
      quiet={quiet}
      onPanelStep={onPanelStep}
      advance={advance}
      // Only the root panel gets the tour's "click ✕ to exit" nudge — a nested
      // zoom is off-script and closing it doesn't leave the close-up.
      highlightClose={highlightClose && i === 0}
      onClose={() => onPop(i)}
    />
  ))
}

function Panel({
  ctx,
  depth,
  active,
  openCloseUp,
  highlightClose,
  held,
  quiet,
  onPanelStep,
  advance,
  onClose,
}) {
  // (ctx.sub is the panel's subtitle; `sub` below is the manual scrub position)
  const { title, steps, Stage, stageProps, source, className, dwell, units } = ctx
  const last = steps.length - 1
  const [step, setStep] = useState(0)
  const [playing, setPlaying] = useState(true)
  // Manual scrub position INSIDE a step's replay, or null while the stage
  // animates itself. A stage that declares `units(step)` can be stepped one arc
  // decision / one row / one character at a time; everything else has one unit
  // per step and behaves exactly as before. Expressed as a value the stage
  // reads — never by clearing `active`, which stages use to park their timers.
  const [sub, setSub] = useState(null)
  const unitsAt = (i) => Math.max(1, units?.(i) ?? 1)

  // Auto-play clock. `dwell` is a per-step budget (a stage with flights or a
  // probe replay to fit needs more than the flat default); it is excluded from
  // the deps because build() hands over a fresh closure on every re-derive.
  // `held` freezes the clock without clearing `active`: a tour step that is
  // asking the reader to LOOK at this panel must not have the panel play on
  // past the thing being described. It cannot be folded into `active`, because
  // stages read that to park their own timers and useReveal JUMPS TO THE END
  // when it goes false — which would finish the very animation we are holding.
  useEffect(() => {
    if (!playing || !active || held) return
    if (step >= last) {
      setPlaying(false)
      return
    }
    const ms = dwell?.(step) ?? INSPECTOR_DWELL_MS
    const id = setTimeout(() => {
      setStep((s) => Math.min(last, s + 1))
      setSub(null) // auto-play hands the replay back to the stage's own clock
    }, ms)
    return () => clearTimeout(id)
    // `held` belongs in here: the tour tip appears a beat AFTER the panel opens,
    // so a dwell timer is already in flight by the time it flips. Without the
    // dep the effect never re-runs, the pending timeout is never cleared, and
    // the panel steps once more before it settles — which is exactly the step
    // the reader was being asked to look at.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, active, held, step, last])

  // Spring out of the clicked element, measured once at mount while the page
  // (or the parent panel) is still at rest behind the opening overlay.
  const [initial] = useState(() => {
    const c = rectCenter(selectorRect(source))
    return c
      ? {
          opacity: 0,
          scale: 0.25,
          x: c.x - window.innerWidth / 2,
          y: c.y - window.innerHeight / 2,
        }
      : { opacity: 0, scale: 0.25 }
  })

  // Prev/Next scrub SUB-UNITS first and only roll over to the neighbouring step
  // once a replay is exhausted, so the reader can walk the intersection one
  // decision at a time. Going back lands at the END of the previous step, which
  // is where that step left off — arriving at its start would rewind a replay
  // the reader just watched.
  const go = (delta) => {
    setPlaying(false)
    const here = unitsAt(step)
    const at = sub ?? here
    if (delta > 0) {
      if (at < here) setSub(at + 1)
      else if (step < last) {
        setStep(step + 1)
        setSub(unitsAt(step + 1) > 1 ? 0 : null)
      }
    } else {
      if (at > 0 && here > 1) setSub(Math.max(0, at - 1))
      else if (step > 0) {
        setStep(step - 1)
        setSub(unitsAt(step - 1))
      }
    }
  }

  const current = steps[step]
  const unitsHere = unitsAt(step)

  // Report the active panel's position up, so a tour step can wait for the
  // panel to reach the beat it is about to describe — including how far INTO a
  // step's replay the reader has scrubbed, which is what lets a scenario walk
  // someone through the intersection one decision at a time. Only the ACTIVE
  // panel reports: a nested zoom would otherwise overwrite its parent's.
  useEffect(() => {
    if (active) onPanelStep?.(step, last, sub, unitsHere)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, step, last, sub, unitsHere])

  // A tour step can drive the replay from its own tooltip — `advance` is a
  // counter App bumps on each press, so the panel walks forward without the
  // reader having to leave the tip and find the mini-stepper. Seeded from the
  // incoming value so mounting mid-tour never counts as a press.
  const advanceRef = useRef(advance)
  useEffect(() => {
    if (advance === advanceRef.current) return
    advanceRef.current = advance
    if (active) go(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [advance, active])

  const subAt = sub ?? unitsHere
  // At the very start there is nothing to go back to — including when the
  // stage's own clock is driving (sub == null), which is how the panel opens.
  const atStart = step <= 0 && (sub == null || sub <= 0)
  const atEnd = step >= last && subAt >= unitsHere

  return (
    <motion.div
      className="shard-inspector-backdrop"
      // Stride of 1 so even a deeply nested stack stays under the walkthrough's
      // z-index 70 — the tour has to be able to spotlight controls inside a panel.
      style={{ zIndex: 60 + depth }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      onClick={onClose}
    >
      <motion.div
        className={'shard-inspector' + (className ? ' ' + className : '')}
        initial={initial}
        animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
        transition={{ type: 'spring', stiffness: 260, damping: 26 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="si-head">
          <div className="si-title">{title}</div>
          <div className="si-close-wrap">
            {/* Not while a read-this tour tip is up: the last step is exactly
                where the payoff lands (the fuzzy walk finishing its word on an
                accepting state), and inviting the reader to leave at that
                moment is the one thing this hint must not do. */}
            {highlightClose && step >= last && !quiet && (
              <span className="si-close-hint">Done exploring? Click ✕ to exit →</span>
            )}
            <button
              className={'si-close' + (highlightClose ? ' tour-pulse' : '')}
              onClick={onClose}
              title="Close"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="si-explain">
          <h4>{current.title}</h4>
          <p>{current.blurb}</p>
          {/* A step may carry one `link: { label, url }` — further reading for
              the reader standing in front of the thing it explains. Used where a
              step has to admit a simplification and owes the real story a
              pointer; the panel keeps its state, since the link opens a tab. */}
          {current.link && <DocLinks title="Read more" links={[current.link]} />}
        </div>

        {/* The stage returns a FRAGMENT, so its pinned strips (.si-querybox) and
            its scroller (.si-scroll) are direct flex children of
            .shard-inspector — which is what the stylesheet's `> .si-*` rules
            expect. Don't wrap it in a div. */}
        <Stage
          step={step}
          sub={sub}
          active={active}
          openCloseUp={openCloseUp}
          {...stageProps}
        />

        <div className="si-stepper">
          <Stepper
            // Named so a tour step can spotlight it as a `targetExtra` — the dim
            // layer swallows clicks outside the hole, so a step that asks the
            // reader to walk the replay with Next has to expose these controls.
            dataTour="cu-stepper"
            steps={steps}
            step={step}
            opLabel={ctx.sub}
            playing={playing && active}
            canPrev={!atStart}
            canNext={!atEnd}
            // Only while the reader is scrubbing. During auto-play the stage's
            // own clock owns the position and the panel does not know it, so a
            // counter here would sit at "n / n" while the replay was still
            // halfway through — worse than no counter at all.
            subLabel={sub != null && unitsHere > 1 ? `${Math.min(sub, unitsHere)} / ${unitsHere}` : null}
            onPrev={() => go(-1)}
            onNext={() => go(1)}
            onPlay={() => {
              setSub(null) // hand the replay back to the stage's clock
              setPlaying(true)
            }}
            // Freeze where the replay actually is rather than letting it run on
            // under a paused stepper: useReveal's `on` goes false and parks at
            // the end, so `sub` has to say "the end" for the picture to hold
            // still instead of jumping.
            onPause={() => {
              setSub(unitsHere)
              setPlaying(false)
            }}
          />
        </div>
      </motion.div>
    </motion.div>
  )
}
