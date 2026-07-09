# bitvis

Interactive, step-by-step visualizations that make distributed systems make
sense — each one simulated entirely client-side, no backend. This is the
umbrella monorepo for the visualizations served under `*.bitsculpt.top`, plus
the landing page that ties them together.

**Live:** https://bitvis.bitsculpt.top

## Packages

| Package | Live | What it teaches |
| --- | --- | --- |
| [`packages/kubevis`](packages/kubevis) | [kubevis.bitsculpt.top](https://kubevis.bitsculpt.top) | How Kubernetes turns kubectl commands into running pods (control plane, scheduler, self-healing). |
| [`packages/opensearchvis`](packages/opensearchvis) | [opensearchvis.bitsculpt.top](https://opensearchvis.bitsculpt.top) | How OpenSearch indexes and searches a distributed cluster (segments, refresh/flush/merge, scatter-gather). |
| [`packages/landing`](packages/landing) | [bitvis.bitsculpt.top](https://bitvis.bitsculpt.top) | The landing page — a plain static card grid linking to every visualization. |

Each visualization is an independent Vite + React app. They share tooling and
the deploy infrastructure, but nothing at runtime — every site gets its own
CloudFront distribution, S3 bucket, and ACM certificate.

## Develop

This is an npm workspaces monorepo, so install once at the root:

```bash
npm install
```

Then run any app's dev server:

```bash
npm run dev:kubevis          # or:  npm run dev -w @bitvis/kubevis
npm run dev:opensearchvis    # or:  npm run dev -w @bitvis/opensearchvis
npm run build                # build every app to packages/*/dist
```

The landing page has no build step — open `packages/landing/index.html` or serve
the folder (`npx serve packages/landing`).

## Deploy

Infrastructure is AWS CDK (S3 + CloudFront + Route 53 + ACM) in [`infra/`](infra),
one `StaticSiteStack` per site, all defined in [`infra/bin/app.ts`](infra/bin/app.ts).
The two visualization stacks (`KubevisStack`, `OpensearchvisStack`) keep the same
stack ids as before the monorepo, so deploys update them in place.

```bash
./scripts/deploy.sh                # build all + deploy every site
./scripts/deploy.sh KubevisStack   # build all + deploy one stack
```

Deploy requires the `bitsculpt` AWS profile, so it only runs on the owner's
machine. The `bitsculpt.top` Route 53 hosted zone is imported (never created or
destroyed) by every stack.

## Adding a new visualization

1. Add `packages/<name>/` (copy an existing app as a starting point; set its
   `package.json` name to `@bitvis/<name>`).
2. Add a `StaticSiteStack` for it in `infra/bin/app.ts` with its `subDomain` and
   `sourceDir` (`../packages/<name>/dist`, or the folder itself if it's static).
3. Append an entry to `packages/landing/sites.js` so it shows up on the landing
   page.
