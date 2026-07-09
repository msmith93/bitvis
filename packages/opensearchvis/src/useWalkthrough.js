import { useEffect, useRef, useState } from 'react'
import { TOUR_STEPS } from './walkthroughSteps'

// The guided-tour state machine: which step is current, whether it should be
// rendered right now, and how it moves forward. The tour starts running on
// every page load — deliberately no persistence, matching the app's
// everything-in-React rule — and 'done' is terminal for the session.
//
// `snapshot` is a plain object App rebuilds each render from state it already
// owns; `actions` are the few app controls a step may invoke on entry
// (currently just `pause`). Steps advance when their `advanceOn` predicate
// observes the user's real action, so the effects below intentionally run on
// every render rather than diffing the snapshot's fields.
export function useWalkthrough(snapshot, actions) {
  const [status, setStatus] = useState('running') // 'running' | 'done'
  const [stepIndex, setStepIndex] = useState(0)
  const shownRef = useRef(-1) // last step whose onShow fired

  const step = status === 'running' ? TOUR_STEPS[stepIndex] : null
  const visible = !!step && (!step.waitFor || step.waitFor(snapshot))

  // Fire onShow once per step, at the moment the step first becomes visible. A
  // step can be entered long before its waitFor lets it render — the magnify
  // step is entered when the search op starts but only shows at the
  // local-search phase, where onShow pauses the timeline.
  useEffect(() => {
    if (!step || !visible || shownRef.current === stepIndex) return
    shownRef.current = stepIndex
    step.onShow?.(snapshot, actions)
  })

  // Auto-advance: the user's real action flips the current step's advanceOn.
  // Evaluated even while the step is hidden, so a user who deviates from the
  // script (e.g. presses ▶ Play instead of clicking 🔍) still moves the tour.
  useEffect(() => {
    if (!step || !step.advanceOn || !step.advanceOn(snapshot)) return
    if (stepIndex >= TOUR_STEPS.length - 1) setStatus('done')
    else setStepIndex(stepIndex + 1)
  })

  const end = () => setStatus('done')
  const next = () =>
    stepIndex >= TOUR_STEPS.length - 1 ? end() : setStepIndex(stepIndex + 1)

  return {
    status,
    stepIndex,
    stepCount: TOUR_STEPS.length,
    step,
    visible,
    next,
    skip: end,
    finish: end,
    abort: end,
  }
}
