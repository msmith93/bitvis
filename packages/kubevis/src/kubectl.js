// A small, tolerant kubectl parser + kubectl-style table formatters. The
// parser only decides WHAT the user asked for and validates it against the
// committed cluster; App turns the result into an op payload and starts it.

import { MAX_REPLICAS, EVENTS_SHOWN } from './constants'
import {
  WORKER_NODES,
  CONTROL_PLANE_NODE,
  BASE_VERSION,
  schedulableCapacity,
  serviceEndpoints,
  fakePodIP,
} from './cluster'

const RESOURCE_ALIASES = {
  pod: 'pods', pods: 'pods', po: 'pods',
  deployment: 'deployments', deployments: 'deployments', deploy: 'deployments',
  replicaset: 'replicasets', replicasets: 'replicasets', rs: 'replicasets',
  node: 'nodes', nodes: 'nodes', no: 'nodes',
  event: 'events', events: 'events', ev: 'events',
  service: 'services', services: 'services', svc: 'services',
  ingress: 'ingress', ingresses: 'ingress', ing: 'ingress',
  endpoints: 'endpoints', endpoint: 'endpoints', ep: 'endpoints',
}

const NAME_RE = /^[a-z]([a-z0-9-]*[a-z0-9])?$/

export const HELP_LINES = [
  'Supported commands:',
  '  kubectl create deployment <name> --image=<image> [--replicas=<n>]',
  '  kubectl scale deployment <name> --replicas=<n>',
  '  kubectl delete pod | service | ingress <name>',
  '  kubectl cordon | uncordon | drain <node>',
  '  kubectl expose deployment <name> [--port=<n>]',
  '  kubectl create ingress <name> --rule=<host>/*=<service>:<port>',
  '  kubectl get pods | deployments | replicasets | nodes | events |',
  '              services | ingress | endpoints',
  '  help · clear',
  '',
  `Simulator limits: replicas 0-${MAX_REPLICAS}, 4 pods per worker node.`,
  'The simulate bar above the stage triggers pod/node crashes, recovery and upgrades.',
]

// Split into words, folding `--flag=value` and `--flag value` into flags.
function tokenize(input) {
  const words = input.trim().split(/\s+/)
  const args = []
  const flags = {}
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (w.startsWith('--')) {
      const eq = w.indexOf('=')
      if (eq >= 0) flags[w.slice(2, eq)] = w.slice(eq + 1)
      else {
        const next = words[i + 1]
        if (next && !next.startsWith('--')) {
          flags[w.slice(2)] = next
          i++
        } else flags[w.slice(2)] = ''
      }
    } else args.push(w)
  }
  return { args, flags }
}

const err = (message) => ({ kind: 'error', message })

// parse(input, base) -> { kind, ... } where kind is one of:
// error | help | clear | get | create | scale | deletePod | noop
export function parseCommand(input, base) {
  const trimmed = input.trim()
  if (!trimmed) return { kind: 'noop' }
  if (trimmed === 'help' || trimmed === '?') return { kind: 'help' }
  if (trimmed === 'clear') return { kind: 'clear' }

  const { args, flags } = tokenize(trimmed)
  if (args[0] !== 'kubectl')
    return err(`command not found: ${args[0]} — type "help" for what this terminal supports`)

  const verb = args[1]
  switch (verb) {
    case 'get': {
      const resource = RESOURCE_ALIASES[args[2]]
      if (!resource)
        return err(`error: the server doesn't have a resource type "${args[2] ?? ''}" — try pods, deployments, replicasets, nodes or events`)
      return { kind: 'get', resource }
    }

    case 'expose': {
      if (args[2] !== 'deployment' && !(args[2] || '').startsWith('deployment/'))
        return err('error: usage: kubectl expose deployment <name> [--port=<n>]')
      const name = args[2].startsWith('deployment/')
        ? args[2].split('/')[1]
        : args[3]
      if (!base.deployments[name])
        return err(`Error from server (NotFound): deployments.apps "${name ?? ''}" not found`)
      if (base.services[name])
        return err(`Error from server (AlreadyExists): services "${name}" already exists`)
      const port = flags.port === undefined ? 80 : Number(flags.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        return err('error: --port must be a valid port number')
      return { kind: 'expose', name, port }
    }

    case 'create': {
      if (args[2] === 'ingress') {
        const name = args[3]
        if (!name || !NAME_RE.test(name))
          return err('error: a lowercase DNS-style ingress name is required')
        if (base.ingresses[name])
          return err(`Error from server (AlreadyExists): ingresses.networking.k8s.io "${name}" already exists`)
        const rule = (flags.rule || '').replace(/^["']|["']$/g, '')
        if (!rule)
          return err('error: required flag(s) "rule" not set — e.g. --rule=demo.kubevis.dev/*=web:80')
        // <host>/<path>=<service>:<port> — service:port sits after the LAST '='
        const eq = rule.lastIndexOf('=')
        const left = eq >= 0 ? rule.slice(0, eq) : ''
        const right = eq >= 0 ? rule.slice(eq + 1) : ''
        const [serviceName, portStr] = right.split(':')
        const servicePort = Number(portStr)
        const host = left.split('/')[0]
        const path = left.slice(host.length) || '/*'
        if (!host || !serviceName || !Number.isInteger(servicePort))
          return err('error: could not parse --rule — expected <host>/<path>=<service>:<port>, e.g. demo.kubevis.dev/*=web:80')
        return { kind: 'createIngress', name, host, path, serviceName, servicePort }
      }
      if (args[2] !== 'deployment')
        return err(`error: this simulator can only create deployments and ingresses (got "${args[2] ?? ''}")`)
      const name = args[3]
      if (!name || !NAME_RE.test(name))
        return err('error: a lowercase DNS-style name is required, e.g. kubectl create deployment web --image=nginx')
      if (base.deployments[name])
        return err(`error: failed to create deployment: deployments.apps "${name}" already exists`)
      if (!flags.image)
        return err('error: required flag(s) "image" not set')
      const replicas = flags.replicas === undefined ? 1 : Number(flags.replicas)
      if (!Number.isInteger(replicas) || replicas < 1 || replicas > MAX_REPLICAS)
        return err(`error: --replicas must be an integer between 1 and ${MAX_REPLICAS} (simulator limit)`)
      if (schedulableCapacity(base) < replicas)
        return err('error: not enough free capacity on schedulable Ready nodes (4 pods per worker; cordoned/NotReady nodes don’t count)')
      return { kind: 'create', name, image: flags.image, replicas }
    }

    case 'scale': {
      if (args[2] !== 'deployment' && !(args[2] || '').startsWith('deployment/'))
        return err('error: usage: kubectl scale deployment <name> --replicas=<n>')
      const name = args[2].startsWith('deployment/')
        ? args[2].split('/')[1]
        : args[3]
      const dep = base.deployments[name]
      if (!dep)
        return err(`Error from server (NotFound): deployments.apps "${name ?? ''}" not found`)
      if (flags.replicas === undefined)
        return err('error: required flag(s) "replicas" not set')
      const replicas = Number(flags.replicas)
      if (!Number.isInteger(replicas) || replicas < 0 || replicas > MAX_REPLICAS)
        return err(`error: --replicas must be an integer between 0 and ${MAX_REPLICAS} (simulator limit)`)
      if (
        replicas > dep.replicas &&
        schedulableCapacity(base) < replicas - dep.replicas
      )
        return err('error: not enough free capacity on schedulable Ready nodes (4 pods per worker; cordoned/NotReady nodes don’t count)')
      return { kind: 'scale', name, replicas, from: dep.replicas }
    }

    case 'delete': {
      const kindArg = args[2] || ''
      const slashName = kindArg.includes('/') ? kindArg.split('/')[1] : null
      if (kindArg === 'service' || kindArg === 'svc' || kindArg.startsWith('service/') || kindArg.startsWith('svc/')) {
        const name = slashName ?? args[3]
        if (!base.services[name])
          return err(`Error from server (NotFound): services "${name ?? ''}" not found`)
        return { kind: 'deleteService', name }
      }
      if (kindArg === 'ingress' || kindArg === 'ing' || kindArg.startsWith('ingress/') || kindArg.startsWith('ing/')) {
        const name = slashName ?? args[3]
        if (!base.ingresses[name])
          return err(`Error from server (NotFound): ingresses.networking.k8s.io "${name ?? ''}" not found`)
        return { kind: 'deleteIngress', name }
      }
      if (kindArg !== 'pod' && !kindArg.startsWith('pod/'))
        return err('error: this simulator can only delete pods, services and ingresses')
      const podName = kindArg.startsWith('pod/') ? slashName : args[3]
      const pod = base.pods[podName]
      if (!pod)
        return err(`Error from server (NotFound): pods "${podName ?? ''}" not found`)
      if (pod.phase === 'Terminating')
        return err(`error: pod "${podName}" is already terminating`)
      return { kind: 'deletePod', podName }
    }

    case 'cordon':
    case 'uncordon':
    case 'drain': {
      const nodeId = args[2]
      if (nodeId === CONTROL_PLANE_NODE)
        return err(`error: this simulator doesn't ${verb} the control-plane node — its components are static pods, which drain ignores anyway`)
      const node = base.nodes[nodeId]
      if (!node)
        return err(`Error from server (NotFound): nodes "${nodeId ?? ''}" not found`)
      if (!node.ready && verb !== 'uncordon')
        return err(`error: node "${nodeId}" is NotReady — recover it first (simulate bar)`)
      if (verb === 'cordon' && node.unschedulable)
        return { kind: 'info', message: `node/${nodeId} already cordoned` }
      if (verb === 'uncordon' && !node.unschedulable)
        return { kind: 'info', message: `node/${nodeId} already uncordoned` }
      // Real drains usually need --ignore-daemonsets; we have none, so the
      // flag is accepted and ignored (same for --force). Drain never blocks
      // on capacity: evicted pods may legitimately stay Pending.
      return { kind: verb, node: nodeId }
    }

    case 'apply':
    case 'rollout':
    case 'describe':
    case 'logs':
      return err(`error: "kubectl ${verb}" isn't in this simulator yet — see the roadmap in the README`)

    default:
      return err(`error: unknown command "kubectl ${verb ?? ''}" — type "help"`)
  }
}

// ---- Table formatters -------------------------------------------------------

const START_TS = Date.now()

// kubectl-ish age: seconds under 2 minutes, whole minutes under an hour.
export function ageStr(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 120) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}

function table(headers, rows) {
  const all = [headers, ...rows]
  const widths = headers.map((_, i) =>
    Math.max(...all.map((r) => String(r[i]).length)),
  )
  return all.map((r) =>
    r.map((cell, i) => String(cell).padEnd(widths[i] + 3)).join('').trimEnd(),
  )
}

export function formatGet(resource, cluster) {
  switch (resource) {
    case 'pods': {
      const pods = Object.values(cluster.pods)
      if (pods.length === 0) return ['No resources found in default namespace.']
      return table(
        ['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE', 'NODE'],
        pods.map((p) => [
          p.name,
          p.phase === 'Running' ? '1/1' : '0/1',
          p.phase,
          p.restarts ?? 0,
          ageStr(p.createdAt),
          p.node ?? '<none>',
        ]),
      )
    }
    case 'deployments': {
      const deps = Object.values(cluster.deployments)
      if (deps.length === 0) return ['No resources found in default namespace.']
      const readyOf = (d) =>
        Object.values(cluster.pods).filter(
          (p) => p.deployment === d.name && p.phase === 'Running',
        ).length
      return table(
        ['NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'AGE'],
        deps.map((d) => [
          d.name,
          `${readyOf(d)}/${d.replicas}`,
          d.replicas,
          readyOf(d),
          ageStr(d.createdAt),
        ]),
      )
    }
    case 'replicasets': {
      const rss = Object.values(cluster.replicaSets)
      if (rss.length === 0) return ['No resources found in default namespace.']
      const of = (rs, phase) =>
        Object.values(cluster.pods).filter(
          (p) => p.rs === rs.name && (!phase || p.phase === phase),
        ).length
      return table(
        ['NAME', 'DESIRED', 'CURRENT', 'READY', 'AGE'],
        rss.map((rs) => [
          rs.name,
          rs.replicas,
          of(rs),
          of(rs, 'Running'),
          ageStr(rs.createdAt),
        ]),
      )
    }
    case 'nodes': {
      const status = (n) =>
        !n.ready
          ? 'NotReady'
          : n.unschedulable
          ? 'Ready,SchedulingDisabled'
          : 'Ready'
      return table(
        ['NAME', 'STATUS', 'ROLES', 'AGE', 'VERSION'],
        [
          [CONTROL_PLANE_NODE, 'Ready', 'control-plane', ageStr(START_TS), BASE_VERSION],
          ...WORKER_NODES.map((w) => {
            const n = cluster.nodes[w.id]
            return [w.id, status(n), '<none>', ageStr(START_TS), n.version]
          }),
        ],
      )
    }
    case 'services': {
      const svcs = Object.values(cluster.services)
      if (svcs.length === 0) return ['No resources found in default namespace.']
      return table(
        ['NAME', 'TYPE', 'CLUSTER-IP', 'PORT(S)', 'AGE'],
        svcs.map((s) => [
          s.name, 'ClusterIP', s.clusterIP, `${s.port}/TCP`, ageStr(s.createdAt),
        ]),
      )
    }
    case 'ingress': {
      const ings = Object.values(cluster.ingresses)
      if (ings.length === 0) return ['No resources found in default namespace.']
      return table(
        ['NAME', 'CLASS', 'HOSTS', 'PORTS', 'AGE'],
        ings.map((i) => [i.name, 'nginx', i.host, 80, ageStr(i.createdAt)]),
      )
    }
    case 'endpoints': {
      const svcs = Object.values(cluster.services)
      if (svcs.length === 0) return ['No resources found in default namespace.']
      return table(
        ['NAME', 'ENDPOINTS', 'AGE'],
        svcs.map((s) => {
          const eps = serviceEndpoints(cluster, s)
          return [
            s.name,
            eps.length === 0
              ? '<none>'
              : eps.map((p) => `${fakePodIP(p.name)}:${s.port}`).join(','),
            ageStr(s.createdAt),
          ]
        }),
      )
    }
    case 'events': {
      const evs = cluster.events.slice(-EVENTS_SHOWN)
      if (evs.length === 0) return ['No events found in default namespace.']
      return table(
        ['TYPE', 'REASON', 'OBJECT', 'MESSAGE'],
        evs.map((e) => [e.type ?? 'Normal', e.reason, e.obj, e.message]),
      )
    }
    default:
      return ['No resources found.']
  }
}
