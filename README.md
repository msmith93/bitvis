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
| [`packages/elasticsearchvis`](packages/elasticsearchvis) | [elasticsearchvis.bitsculpt.top](https://elasticsearchvis.bitsculpt.top) | How Elasticsearch indexes and searches a distributed cluster (segments, refresh/flush/merge, scatter-gather). |
| [`packages/cassandravis`](packages/cassandravis) | [cassandravis.bitsculpt.top](https://cassandravis.bitsculpt.top) | How a leaderless NoSQL store (Cassandra) replicates and stores data (the ring, tunable quorums, hinted handoff, read repair, the LSM tree). |
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
npm run dev:kubevis             # or:  npm run dev -w @bitvis/kubevis
npm run dev:elasticsearchvis    # or:  npm run dev -w @bitvis/elasticsearchvis
npm run dev:cassandravis        # or:  npm run dev -w @bitvis/cassandravis
npm run build                   # build every app to packages/*/dist
```

The landing page has no build step — open `packages/landing/index.html` or serve
the folder (`npx serve packages/landing`).

## Deploy

Infrastructure is AWS CDK (S3 + CloudFront + Route 53 + ACM) in [`infra/`](infra),
one `StaticSiteStack` per site, all defined in [`infra/bin/app.ts`](infra/bin/app.ts).
`KubevisStack` keeps the same stack id it had before the monorepo, so deploys
update it in place. `ElasticsearchvisStack` is the opensearchvis rebrand — new
stack id *and* new subdomain — so its first deploy provisions fresh
infrastructure rather than updating the old stack.

```bash
./scripts/deploy.sh                # build all + deploy every site
./scripts/deploy.sh KubevisStack   # build all + deploy one stack
```

### Retiring a hostname

`StaticSiteStack` takes an optional `redirectFrom` list of retired FQDNs, which
is how `opensearchvis.bitsculpt.top` still resolves after the rebrand. Each name
is added as an alternate domain name on the site's own distribution and as a SAN
on its cert — CloudFront matches the `Host` header against that list, so a
Route 53 record by itself would only earn a cert mismatch and a 403 — and a
viewer-request function 301s it to the canonical name, path and query string
intact.

CloudFront requires alternate domain names to be globally unique, so the old
distribution must release the name **before** the new stack claims it:

```bash
AWS_PROFILE=bitsculpt npx cdk destroy OpensearchvisStack   # first
./scripts/deploy.sh ElasticsearchvisStack                  # then
```

Run in the other order and the deploy fails with `CNAMEAlreadyExists`. Adding a
`redirectFrom` entry also replaces the ACM cert (certs are immutable), so expect
that deploy to spend a few extra minutes on DNS revalidation.

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
