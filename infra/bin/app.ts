#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { StaticSiteStack } from '../lib/static-site-stack';

const app = new cdk.App();

new StaticSiteStack(app, 'KubevisStack', {
  // CloudFront requires ACM certs in us-east-1. Deploy the whole stack there.
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  domainName: 'bitsculpt.top',
  subDomain: 'kubevis',
  hostedZoneId: 'Z06315621CLJIHGAQROPU',
});
