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
  {
    id: 'cassandravis',
    title: 'cassandravis',
    tag: 'Cassandra',
    tagline: 'How a leaderless NoSQL store replicates and stores data.',
    blurb:
      'Put a key and watch it hash onto the consistent-hashing ring, fan out to 3 replicas, and ack at your chosen quorum — then crash a node to see hinted handoff, read repair, Merkle-tree repair, and the LSM tree underneath.',
    url: 'https://cassandravis.bitsculpt.top',
    icon: '◍', // ◍ the token ring
    accent: '#1287b1',
  },
];

// Games — a separate category from the visualizations, shown in their own
// section at the bottom. Same card shape; adding one = append an entry here.
window.GAMES = [
  {
    id: 'asteroid',
    title: 'asteroid',
    tag: 'Coding game',
    tagline: 'A coding game you play in the browser.',
    blurb:
      'Not a visualization — a game where you write code to play. Jump in and give it a go.',
    url: 'https://asteroid.bitsculpt.top',
    icon: '☄', // ☄ comet / asteroid
    accent: '#a06cff',
  },
];
