#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { StaticSiteStack } from '../lib/static-site-stack';

const app = new cdk.App();

// Shared config for every site. CloudFront requires ACM certs in us-east-1,
// so all stacks deploy there. The hosted zone for bitsculpt.top is imported
// (not created) by each stack.
const common = {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  domainName: 'bitsculpt.top',
  hostedZoneId: 'Z06315621CLJIHGAQROPU',
};

// One stack per site. Each is fully independent (own bucket/distribution/cert/
// alias) — the monorepo shares the construct, not the infrastructure. KubevisStack
// matches its pre-existing deployed stack so `cdk deploy` updates it in place.
// ElasticsearchvisStack is the opensearchvis rebrand: both the stack id and the
// subdomain changed, so its first deploy provisions a NEW stack (bucket,
// distribution, cert, alias) rather than updating the old one.
new StaticSiteStack(app, 'KubevisStack', {
  ...common,
  subDomain: 'kubevis',
  sourceDir: '../packages/kubevis/dist',
});

new StaticSiteStack(app, 'ElasticsearchvisStack', {
  ...common,
  subDomain: 'elasticsearchvis',
  sourceDir: '../packages/elasticsearchvis/dist',
  // Keep links to the pre-rebrand site alive. OpensearchvisStack must already be
  // destroyed when this deploys — CloudFront will not let two distributions
  // claim the same alternate domain name.
  redirectFrom: ['opensearchvis.bitsculpt.top'],
});

new StaticSiteStack(app, 'CassandravisStack', {
  ...common,
  subDomain: 'cassandravis',
  sourceDir: '../packages/cassandravis/dist',
});

// The landing page — plain static, no build step, so its source dir is uploaded directly.
new StaticSiteStack(app, 'LandingStack', {
  ...common,
  subDomain: 'bitvis',
  sourceDir: '../packages/landing',
});
