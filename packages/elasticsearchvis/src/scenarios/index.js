import intro from './intro'
import wildcard from './wildcard'
import routing from './routing'
import ondisk from './ondisk'

// Guided scenarios. Each one is a self-contained module — like an op module in
// src/ops/ — declaring `{ id, label, blurb, steps, setup? }`. Adding a scenario
// = one new module plus an entry here. `useWalkthrough` runs whichever one is
// selected; the topbar's ScenarioPicker switches (or restarts) them.
//
// A step is:
//   { id, target?, targetExtra?, placement?, title, body, cta?, secondary?,
//     highlightPlay?, dataset?, waitFor?(snapshot), advanceOn?(snapshot),
//     onShow?(snapshot, actions) }
//
//   target        CSS selector of the real control to spotlight; null renders a
//                 centered card instead (welcome / finish).
//   targetExtra   CSS selector of a second element the spotlight hole must also
//                 cover when it is present. For controls that OPEN something —
//                 the Load docs menu — since the dim layer swallows clicks
//                 outside the hole and the menu would otherwise be unclickable.
//   waitFor       gates VISIBILITY only. While false the step is entered but
//                 renders nothing — that is how a scenario waits out an
//                 animation, or stays out of the way of an open close-up.
//   advanceOn     moves to the next step when the user's REAL action satisfies
//                 it. A step with neither advanceOn nor cta can never be left,
//                 so give every step one of the two.
//   onShow        fired once, when the step first becomes visible. May drive the
//                 app through `actions` — prefilling inputs, pausing — but never
//                 does the thing the step is asking for.
//   highlightPlay pulses the footer ▶ Play button while this step is showing
//                 (App reads it); pair it with target '[data-tour="stepper-play"]'.
//   dataset       a DATASETS id this step wants loaded. While the step is
//                 showing, the Load docs menu pulses that entry and disables
//                 every other one, so a scripted load cannot pick the wrong set.
//                 The spotlight can't do this itself — its hole is a single
//                 rectangle and can't exclude an item in the middle of a menu.
//
// The snapshot both predicates read (built fresh by App on every render):
//   indexPhase  'closed' | 'editing' | 'flying' | 'done'
//   opType      active op's type, or null
//   opStep      active op's step index, or -1
//   opDone      active op has reached its last step
//   opQuery     active search's query string ('' when not a search)
//   opRouting   active search's routing key (null when unrouted)
//   playing     auto-play clock is running
//   zoomShard   id of the shard being inspected, or null (the close-up stack's
//               ROOT — unchanged by anything opened on top of it)
//   coordZoom   coordinator close-up is the stack root
//   closeUpKind kind of the INNERMOST open close-up, or null when none:
//               'shard' | 'coordinator' | 'dictionary'
//   closeUpDepth how many close-ups are stacked (0 = looking at the cluster)
//   sampleSet   which dataset is loaded: 'sample' | 'routed' | null
//   scenariosOpen the topbar Scenarios menu is open (the intro tour's last step
//               advances on it, to leave the user looking at the menu)
//
// The actions a step may drive: pause, reset, setQuery, setRouting.
export const SCENARIOS = [intro, wildcard, routing, ondisk]

export const DEFAULT_SCENARIO = intro.id

export const scenarioById = (id) => SCENARIOS.find((s) => s.id === id) || intro
