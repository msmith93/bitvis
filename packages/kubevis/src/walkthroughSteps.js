// Declarative script for the first-run guided tour, ported from
// opensearchvis. Each step spotlights a real control and advances when the
// user actually uses it (`advanceOn`), not via a Next button — only the
// centered welcome/finish cards (target: null) and the observe steps advance
// manually. `waitFor` gates VISIBILITY only: while false the tour renders
// nothing, which is how it waits out op animations and lets the SidePanel
// narrate. Predicates read the snapshot App builds:
// { opType, opStep, opDone, playing, deploymentCount, notReadyNodes }.
export const TOUR_STEPS = [
  {
    id: 'welcome',
    target: null,
    title: 'Welcome to kubevis',
    body: [
      'This is a simulated Kubernetes cluster — a terminal that accepts kubectl commands, and a stage that animates what the control plane (API server, etcd, scheduler, controllers, kubelets) actually does with them.',
      'Take the one-minute tour? You will create a deployment, crash a node, watch Kubernetes heal itself, and bring the node back.',
    ],
    cta: 'Start the tour',
    secondary: 'Skip for now',
  },
  {
    id: 'create-deployment',
    target: '[data-tour="preset-create"]',
    placement: 'top',
    title: 'Create your first deployment',
    body: 'Click “create deployment” — it runs kubectl create deployment web --image=nginx --replicas=3 for you. Watch the request hit the API server, land in etcd, and fan out to the controllers.',
    advanceOn: (s) => s.opType === 'createDeployment',
  },
  {
    id: 'watch-create',
    target: '[data-tour="side-panel"]',
    placement: 'left',
    title: 'Three pods, zero humans',
    body: 'You declared desired state; the Deployment and ReplicaSet controllers, the scheduler, and the kubelets did the rest. This panel narrates each step — and the footer stepper lets you scrub any operation back and forth.',
    waitFor: (s) => s.opType === 'createDeployment' && s.opDone && !s.playing,
    cta: 'Next',
  },
  {
    id: 'crash-node',
    target: '[data-tour="scenario-nodeCrash"]',
    placement: 'bottom',
    title: 'Now break something',
    body: 'Click 💥 Node Crash. The busiest worker goes silent — the node controller marks it NotReady, and the ReplicaSet notices it is short on pods.',
    // Scenario buttons are disabled while an op is mid-walk.
    waitFor: (s) => s.opDone && !s.playing,
    advanceOn: (s) => s.opType === 'nodeCrash',
  },
  {
    id: 'watch-crash',
    target: '[data-tour="side-panel"]',
    placement: 'left',
    title: 'Self-healing, with a catch',
    body: 'Replacement pods were scheduled onto the surviving nodes — with NEW names, because pods never move, they are replaced. If the survivors ran out of room, the extras sit Pending. The dead node stays down until someone fixes it.',
    waitFor: (s) => s.opType === 'nodeCrash' && s.opDone && !s.playing,
    cta: 'Next',
  },
  {
    id: 'recover-node',
    target: '[data-tour="scenario-recover"]',
    placement: 'bottom',
    title: 'Bring the node back',
    body: 'Click ♻ Recover Node. The machine reboots and its kubelet rejoins — but notice it comes back EMPTY: the replaced pods stay where they landed. Only pods stuck Pending get scheduled onto the fresh capacity.',
    waitFor: (s) => s.notReadyNodes > 0 && s.opDone && !s.playing,
    advanceOn: (s) => s.opType === 'recoverNode',
  },
  {
    id: 'finish',
    target: null,
    title: 'That’s the control loop!',
    body: [
      'You declared a deployment, lost a node, and watched controllers reconcile actual state back to desired state — no step needed a human.',
      'Try scaling, deleting a pod, draining and upgrading a node, or exposing the deployment with a Service and Ingress to light up the traffic rail. Type "help" in the terminal for the full command list.',
    ],
    // Never surface the end card until the recover animation has completed.
    waitFor: (s) => s.opType === 'recoverNode' && s.opDone,
    cta: 'Done',
  },
]
