// Demo-size caps shared by the kubectl parser (validation), the scheduler
// stand-in, and the stage layout so the cluster never overflows the screen.

export const MAX_REPLICAS = 6 // per deployment, enforced by the parser
export const MAX_PODS_PER_NODE = 4 // stage rows per node column
export const MAX_TOTAL_PODS = 12 // 3 workers x MAX_PODS_PER_NODE

export const EVENTS_SHOWN = 12 // rows in `kubectl get events` and the inspector
