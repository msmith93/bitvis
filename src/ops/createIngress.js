// The `createIngress` op: an Ingress is a ROUTING RULE, not a proxy. The
// ingress CONTROLLER (drawn on the traffic rail; really pods in the cluster)
// was there all along answering 404 — this op just gives it a rule to
// program. Payload: { id, ts, name, host, path, serviceName, servicePort }

import { flightAwareDuration } from './shared'

const STEPS = [
  {
    key: 'request',
    ms: 1900,
    title: '1 · kubectl → API server',
    blurb:
      'kubectl create ingress sends the API server an Ingress object: “requests for this host/path go to this Service and port.” Pure desired state — the ingress controller isn’t contacted directly.',
  },
  {
    key: 'persist',
    ms: 2100,
    title: '2 · Ingress rule recorded in etcd',
    blurb:
      'The Ingress object is stored. It is JUST a rule — it runs nothing and routes nothing by itself. Something has to read it and act on it… which is exactly what controllers do in Kubernetes.',
  },
  {
    key: 'controller',
    ms: 2300,
    title: '3 · The ingress controller programs the route',
    blurb:
      'The ingress controller (which has been running the whole time, answering every request with 404) watches Ingress objects. Its watch fires and it reconfigures its proxy: traffic for the host now forwards to the Service. In a real cluster the controller is itself pods — nginx, Traefik, or a cloud load balancer.',
  },
  {
    key: 'live',
    ms: 2400,
    title: '4 · Watch the traffic rail',
    blurb:
      'The user’s requests now have a complete path: ingress rule → Service → ready endpoints. If the Service exists and has Running pods, the ✗s turn to ✓s — and stay green through pod deletions, drains, and node crashes, as long as at least one replica serves. That resilience is the whole pitch.',
  },
]

export default {
  type: 'createIngress',
  label: 'kubectl create ingress',
  steps: STEPS,

  derive(c, op) {
    const s = op.step
    const p = op.payload
    if (s >= 1) {
      c.ingresses[p.name] = {
        name: p.name,
        host: p.host,
        path: p.path,
        serviceName: p.serviceName,
        servicePort: p.servicePort,
        createdAt: p.ts,
      }
      c.events.push({
        id: `${p.id}-e-ing`,
        type: 'Normal',
        reason: 'Sync',
        obj: `ingress/${p.name}`,
        message: `Scheduled for sync: ${p.host} → ${p.serviceName}:${p.servicePort}`,
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
              tokens: [{ id: `${p.id}-req`, term: `ingress/${p.name}` }],
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
              tokens: [{ id: `${p.id}-ing`, term: `${p.host} → ${p.serviceName}` }],
              fromSel: '[data-fly="apiserver"]',
              toSel: '[data-fly="etcd"]',
            },
          ],
        }
      case 2:
        return {
          focus: ['ingress', 'apiserver'],
          flights: [
            {
              key: `${p.id}:2`,
              tokens: [{ id: `${p.id}-rule`, term: 'rule' }],
              fromSel: '[data-fly="apiserver"]',
              toSel: '[data-fly="ingress"]',
            },
          ],
        }
      case 3:
        return { focus: ['user', 'ingress', `svc:${p.serviceName}`], flights: [] }
      default:
        return { focus: [], flights: [] }
    }
  },

  duration: flightAwareDuration(STEPS),
}
