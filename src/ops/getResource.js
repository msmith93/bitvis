// The `get` op: read-only (no derive, so it never folds into committed state
// — same as opensearchvis's search). Three quick steps that make the read
// path visible: even a humble `kubectl get pods` goes through the API server
// and etcd; kubectl never peeks at nodes directly. Payload:
//   { id, resource, table }  — table pre-formatted by kubectl.js against base.

import { flightAwareDuration } from './shared'

const STEPS = [
  {
    key: 'request',
    ms: 1300,
    title: '1 · kubectl → API server',
    blurb:
      'Reads take the same road as writes: kubectl sends a GET to the kube-apiserver. kubectl never talks to nodes, kubelets, or etcd directly — the API server is the single gateway to cluster state.',
  },
  {
    key: 'read',
    ms: 1500,
    title: '2 · API server reads from etcd',
    blurb:
      'The API server fetches the requested objects from etcd (in real clusters, usually from its watch cache — a warm copy kept in sync with etcd). What you get is the cluster’s recorded state, not a live probe of the machines.',
  },
  {
    key: 'respond',
    ms: 1300,
    title: '3 · Response printed',
    blurb:
      'The API server returns the objects and kubectl formats them as a table — printed in the terminal below. Status columns like Running come from what the kubelets last reported up to the API server.',
  },
]

export default {
  type: 'get',
  label: 'kubectl get',
  steps: STEPS,

  // no derive: get never changes cluster state.

  extra(cluster, op) {
    const p = op.payload
    switch (op.step) {
      case 0:
        return {
          focus: ['kubectl', 'apiserver'],
          flights: [
            {
              key: `${p.id}:0`,
              tokens: [{ id: `${p.id}-req`, term: `get ${p.resource}` }],
              fromSel: '[data-fly="terminal"]',
              toSel: '[data-fly="apiserver"]',
            },
          ],
          output: p.table,
        }
      case 1:
        return { focus: ['apiserver', 'etcd'], flights: [], output: p.table }
      case 2:
        return {
          focus: ['kubectl', 'apiserver'],
          flights: [
            {
              key: `${p.id}:2`,
              tokens: [{ id: `${p.id}-res`, term: `${p.resource} ⏎` }],
              fromSel: '[data-fly="apiserver"]',
              toSel: '[data-fly="terminal"]',
            },
          ],
          output: p.table,
        }
      default:
        return { focus: [], flights: [], output: p.table }
    }
  },

  duration: flightAwareDuration(STEPS),
}
