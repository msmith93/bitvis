// The `expose` op: create a Service in front of a deployment's pods. The key
// idea to land: a Service is a stable VIRTUAL address + a label selector —
// creating one runs nothing new anywhere. The Endpoints controller keeps the
// list of ready pods in sync, and kube-proxy on every node makes the virtual
// IP actually route. Payload:
//   { id, ts, name, port, clusterIP, endpointCount }

import { flightAwareDuration } from './shared'

const STEPS = [
  {
    key: 'request',
    ms: 1900,
    title: '1 · kubectl → API server',
    blurb:
      'kubectl expose asks the API server to create a Service object with a label selector matching the deployment’s pods (app=<name>). As always: one declarative object, through the one front door.',
  },
  {
    key: 'persist',
    ms: 2200,
    title: '2 · Service recorded in etcd — a virtual IP',
    blurb:
      'The Service gets a stable ClusterIP. Note what did NOT happen: no container started, no proxy process launched. A Service is an ADDRESS with a selector, not a workload. The address stays fixed while the pods behind it come and go.',
  },
  {
    key: 'endpoints',
    ms: 2300,
    title: '3 · Endpoints controller lists the ready pods',
    blurb:
      'The Endpoints controller (in the controller-manager) watches Services and Pods, and materializes the selector into a live list of READY pod addresses. Pods that are Pending, Terminating, or crashed are pruned automatically — this list is why traffic never hits a dead pod.',
  },
  {
    key: 'kube-proxy',
    ms: 2400,
    title: '4 · kube-proxy programs every node',
    blurb:
      'On each node, kube-proxy watches the endpoints and rewrites the node’s routing rules so connections to the ClusterIP land on one of the ready pods. The service chip on the traffic rail now shows its live endpoint count — if an Ingress routes here, requests can flow.',
  },
]

export default {
  type: 'expose',
  label: 'kubectl expose',
  steps: STEPS,

  derive(c, op) {
    const s = op.step
    const p = op.payload
    if (s >= 1) {
      c.services[p.name] = {
        name: p.name,
        selector: p.name,
        port: p.port,
        clusterIP: p.clusterIP,
        createdAt: p.ts,
      }
      c.events.push({
        id: `${p.id}-e-svc`,
        type: 'Normal',
        reason: 'CreatedService',
        obj: `service/${p.name}`,
        message: `Service ${p.name} created, ClusterIP ${p.clusterIP}`,
      })
    }
  },

  extra(cluster, op) {
    const p = op.payload
    switch (op.step) {
      case 0:
        return {
          focus: ['kubectl', 'apiserver'],
          flights: [
            {
              key: `${p.id}:0`,
              tokens: [{ id: `${p.id}-req`, term: `expose ${p.name}` }],
              fromSel: '[data-fly="terminal"]',
              toSel: '[data-fly="apiserver"]',
            },
          ],
        }
      case 1:
        return {
          focus: ['apiserver', 'etcd'],
          flights: [
            {
              key: `${p.id}:1`,
              tokens: [{ id: `${p.id}-svc`, term: `svc/${p.name}` }],
              fromSel: '[data-fly="apiserver"]',
              toSel: '[data-fly="etcd"]',
            },
          ],
        }
      case 2:
        return { focus: ['controller', 'apiserver', `svc:${p.name}`], flights: [] }
      case 3:
        return {
          focus: [
            `svc:${p.name}`,
            'kubelet:node-1',
            'kubelet:node-2',
            'kubelet:node-3',
          ],
          flights: [],
        }
      default:
        return { focus: [], flights: [] }
    }
  },

  duration: flightAwareDuration(STEPS),
}
