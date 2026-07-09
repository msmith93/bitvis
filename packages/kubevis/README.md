# kubevis ⎈

An interactive, animated explanation of **how Kubernetes works** — run real
kubectl commands in a terminal simulator and watch, step by step, what the
control plane does with them.

Type `kubectl create deployment web --image=nginx --replicas=3` and scrub
through the whole story: the request hits the **kube-apiserver** (the only
front door), desired state lands in **etcd**, the **controller-manager**'s
reconciliation loops create a ReplicaSet and its Pods, the **kube-scheduler**
binds each pod to a worker node, and the **kubelets** pull images and start
containers. The control plane itself is drawn honestly: a real node running
those components as static pods, tainted `NoSchedule` so your workloads stay
on the workers. Then `kubectl delete pod <name>` and watch the ReplicaSet
controller heal the drift with a brand-new pod — the "aha" of declarative
infrastructure.

Everything is simulated client-side; no cluster required.

## Run it

```bash
npm install
npm run dev
```

## Deploy

Hosted at [kubevis.bitsculpt.top](https://kubevis.bitsculpt.top) via the same
S3 + CloudFront + Route 53 CDK stack as opensearchvis:

```bash
./scripts/deploy.sh   # needs the `bitsculpt` AWS profile
```

## Supported commands (v1)

```
kubectl create deployment <name> --image=<image> [--replicas=<n>]
kubectl scale deployment <name> --replicas=<n>
kubectl delete pod | service | ingress <name>
kubectl cordon | uncordon | drain <node>
kubectl expose deployment <name> [--port=<n>]
kubectl create ingress <name> --rule=<host>/*=<service>:<port>
kubectl get pods | deployments | replicasets | nodes | events | services | ingress | endpoints
help · clear
```

### Serve real (fake) traffic

A synthetic user sends a request every 5 seconds through the ingress
controller — failing with 404s until you build the serving chain:

```
kubectl create deployment web --image=nginx --replicas=3
kubectl expose deployment web --port=80
kubectl create ingress web --rule=demo.kubevis.dev/*=web:80
```

…and the ✗s turn to ✓s. Then delete a pod, drain a node, or crash one —
traffic keeps flowing as long as one replica serves. Scale to 0 or delete
the service and watch the 503s. That's the whole pitch of Kubernetes, live.

A **simulate bar** above the stage covers what kubectl can't type: **Pod
Crash** (the kubelet restarts the container in place — no ReplicaSet
involved), **Node Crash** (heartbeats stop, the node controller marks it
NotReady, pods are replaced on healthy nodes; the node stays down),
**Recover Node**, and **Upgrade Node**.

### The zero-downtime upgrade walkthrough

```
kubectl drain node-1 --ignore-daemonsets   # cordon + evict; pods land elsewhere
[⬆ Upgrade Node]                           # kubelet upgraded on the machine
kubectl uncordon node-1                    # back in the scheduler's pool
kubectl get nodes                          # mixed versions mid-upgrade — normal
```

Use the **stepper** (Prev / Next / Play / Pause) to scrub any operation
forwards and backwards; the right panel explains each step and shows the
desired-state tree as etcd sees it, plus the event stream.

## What it teaches (accurately)

- kubectl talks **only to the API server**; only the API server touches etcd.
- Commands record **desired state first** — controllers make reality converge.
- Controllers and the scheduler are independent **watch/reconcile loops**.
- The scheduler only **binds** pods to nodes; only the **kubelet** runs them.
- Pods are never moved or restarted by the control plane — they are
  **replaced**, with new names (`web-66b6c48dd5-8w5x7` → `web-66b6c48dd5-p4k2m`).

Deliberate simplifications (single namespace, least-loaded scheduling, no
Services/networking, one container per pod) are flagged in [SPEC.md](SPEC.md).

## Roadmap

Rolling updates (`set image`, `rollout undo`), Services & load-balanced
traffic (`expose`), node ops (`cordon`/`drain`, node failure), `describe`,
probes & CrashLoopBackOff, HPA.

---

Built in the style of [opensearchvis](https://github.com/msmith93/opensearchvis):
React + Vite + Framer Motion, with all visible state derived purely from
`(cluster, op)` so every animation can be scrubbed.
