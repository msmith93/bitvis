import { useEffect, useState } from 'react'

// Every one of these visualizers is a desktop simulation: a wide cluster stage
// flanked by control and explanation panels, a step-through footer, and zoom
// affordances that assume a pointer. None of that survives a phone screen, so
// small touch devices get told up front rather than being left to fight the
// layout. The warning is advisory — "Continue anyway" lets a curious visitor
// look around — and it deliberately does NOT persist a dismissal (everything in
// these apps lives in React state only).
const SMALL_SCREEN = '(max-width: 900px), (max-height: 560px)'
const COARSE_POINTER = '(pointer: coarse)'

// Both conditions together: a narrow desktop window still has a mouse and works
// fine, and a big touchscreen is not the case we are warning about.
function isPhoneSized() {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return (
    window.matchMedia(COARSE_POINTER).matches &&
    window.matchMedia(SMALL_SCREEN).matches
  )
}

export default function MobileWarning() {
  const [phone, setPhone] = useState(isPhoneSized)
  const [dismissed, setDismissed] = useState(false)

  // Re-check on resize/rotate: which of the two size queries matches flips when
  // a phone turns sideways, and the warning should not disappear on rotation.
  useEffect(() => {
    const onChange = () => setPhone(isPhoneSized())
    window.addEventListener('resize', onChange)
    window.addEventListener('orientationchange', onChange)
    return () => {
      window.removeEventListener('resize', onChange)
      window.removeEventListener('orientationchange', onChange)
    }
  }, [])

  if (!phone || dismissed) return null

  return (
    <div
      className="mobile-warning"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mobile-warning-title"
    >
      <div className="mobile-warning-card">
        <div className="mobile-warning-icon" aria-hidden="true">
          🖥️
        </div>
        <h2 id="mobile-warning-title">Made for a desktop</h2>
        <p>
          These simulations are built for a desktop browser — a wide screen and a
          mouse. The cluster, the side panels, and the step-by-step controls need
          far more room than a phone can give them.
        </p>
        <p>
          Come back on a laptop or desktop for the full walkthrough. You are
          welcome to look around here, but expect a cramped and awkward layout.
        </p>
        <button className="btn primary" onClick={() => setDismissed(true)}>
          Continue anyway
        </button>
      </div>
    </div>
  )
}
