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
// alias) — the monorepo shares the construct, not the infrastructure. Stack ids
// KubevisStack/OpensearchvisStack match the pre-existing deployed stacks so
// `cdk deploy` updates them in place rather than re-provisioning.
new StaticSiteStack(app, 'KubevisStack', {
  ...common,
  subDomain: 'kubevis',
  sourceDir: '../packages/kubevis/dist',
});

new StaticSiteStack(app, 'OpensearchvisStack', {
  ...common,
  subDomain: 'opensearchvis',
  sourceDir: '../packages/opensearchvis/dist',
});

// The landing page — plain static, no build step, so its source dir is uploaded directly.
new StaticSiteStack(app, 'LandingStack', {
  ...common,
  subDomain: 'bitvis',
  sourceDir: '../packages/landing',
});
