// The visualizations shown on the landing page.
// Adding a new one = append a single entry here (no other file needs to change).
// Rendered by the inline script in index.html.
window.SITES = [
  {
    id: 'kubevis',
    title: 'kubevis',
    tag: 'Kubernetes',
    tagline: 'How Kubernetes turns kubectl commands into running pods.',
    blurb:
      'Type into a kubectl terminal and watch the control plane react — the API server, etcd, scheduler, and controllers schedule, scale, and self-heal pods across worker nodes, one step at a time.',
    url: 'https://kubevis.bitsculpt.top',
    icon: '⎈', // ⎈ helm wheel
    accent: '#326ce5',
  },
  {
    id: 'opensearchvis',
    title: 'opensearchvis',
    tag: 'OpenSearch',
    tagline: 'How OpenSearch indexes and searches a distributed cluster.',
    blurb:
      'Step through index → refresh → flush → merge → search and see the buffer, translog, immutable segments, replicas, and two-phase scatter-gather search come to life.',
    url: 'https://opensearchvis.bitsculpt.top',
    icon: '⌕', // ⌕ search
    accent: '#00a3e0',
  },
];
