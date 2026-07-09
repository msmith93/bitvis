// The `deleteService` and `deleteIngress` ops — small, but they close the
// serving loop: break one link in ingress rule → Service → endpoints and the
// traffic rail shows exactly which hop now fails. Payloads: { id, ts, name }.

const svcSteps = [
  {
    key: 'request',
    ms: 1800,
    title: '1 · kubectl → API server',
    blurb:
      'kubectl asks the API server to delete the Service object. The pods behind it are untouched — they belong to the ReplicaSet, not the Service.',
  },
  {
    key: 'gone',
    ms: 2100,
    title: '2 · Service and its endpoints removed',
    blurb:
      'The Service (and the endpoint list the Endpoints controller maintained for it) is removed from etcd. The stable virtual address is gone; kube-proxy on every node deprograms its rules.',
  },
  {
    key: 'effect',
    ms: 2300,
    title: '3 · The ingress rule now points at nothing',
    blurb:
      'The Ingress rule still exists, but its backend Service doesn’t — the ingress controller answers 503 Service Unavailable. Watch the rail: pods still Running, users still failing. Serving needs every link in the chain.',
  },
]

const ingSteps = [
  {
    key: 'request',
    ms: 1800,
    title: '1 · kubectl → API server',
    blurb:
      'kubectl asks the API server to delete the Ingress object — removing the routing RULE, not the controller and not the Service.',
  },
  {
    key: 'gone',
    ms: 2100,
    title: '2 · Rule removed from etcd',
    blurb:
      'The ingress controller’s watch fires again — this time the rule vanished, so it deprograms the route from its proxy.',
  },
  {
    key: 'effect',
    ms: 2300,
    title: '3 · Back to 404',
    blurb:
      'Requests still reach the ingress controller (it never stopped running), but no rule matches, so users get 404 Not Found. The Service and its pods are perfectly healthy — and perfectly unreachable from outside.',
  },
]

function makeDeleteOp(type, label, steps, kind) {
  return {
    type,
    label,
    steps,
    derive(c, op) {
      const s = op.step
      const p = op.payload
      if (s >= 1) {
        if (kind === 'service') delete c.services[p.name]
        else delete c.ingresses[p.name]
        c.events.push({
          id: `${p.id}-e-del`,
          type: 'Normal',
          reason: 'Deleted',
          obj: `${kind}/${p.name}`,
          message: `${kind === 'service' ? 'Service' : 'Ingress'} ${p.name} deleted`,
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
                tokens: [{ id: `${p.id}-req`, term: `delete ${kind}/${p.name}` }],
                fromSel: '[data-fly="terminal"]',
                toSel: '[data-fly="apiserver"]',
              },
            ],
          }
        case 1:
          return { focus: ['apiserver', 'etcd'], flights: [] }
        case 2:
          return { focus: ['user', 'ingress'], flights: [] }
        default:
          return { focus: [], flights: [] }
      }
    },
  }
}

export const deleteService = makeDeleteOp(
  'deleteService',
  'kubectl delete service',
  svcSteps,
  'service',
)
export const deleteIngress = makeDeleteOp(
  'deleteIngress',
  'kubectl delete ingress',
  ingSteps,
  'ingress',
)
