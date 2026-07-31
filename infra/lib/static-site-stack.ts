import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

// 'opensearchvis.bitsculpt.top' -> 'OpensearchvisBitsculptTop', for use in a
// CloudFormation logical id (which allows alphanumerics only).
function pascalCase(hostname: string): string {
  return hostname
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

interface StaticSiteProps extends cdk.StackProps {
  domainName: string;
  subDomain: string;
  hostedZoneId: string;
  // Directory (relative to infra/) uploaded to S3. For built apps this is the
  // package's dist/ (e.g. '../packages/kubevis/dist'); for the plain-static
  // landing page it's the source dir directly ('../packages/landing').
  sourceDir: string;
  // Retired FQDNs that should 301 to this site's canonical name (e.g. a
  // hostname left behind by a rename). Each is added as an alternate domain
  // name on THIS distribution and as a SAN on its cert — CloudFront matches the
  // Host header against that list, so a Route 53 record alone would only get a
  // cert mismatch and a 403. A viewer-request function then redirects them.
  //
  // CloudFront requires an alternate domain name to be globally unique, so a
  // retired name must be released by its old distribution BEFORE it is added
  // here, or the deploy fails with CNAMEAlreadyExists.
  redirectFrom?: string[];
}

export class StaticSiteStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: StaticSiteProps) {
    super(scope, id, props);

    const fqdn = `${props.subDomain}.${props.domainName}`;
    const redirectFrom = props.redirectFrom ?? [];

    // Import the existing hosted zone — does NOT create or manage it.
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.domainName,
    });

    // ACM cert with DNS validation. CDK auto-creates the Route 53 CNAME record
    // and waits for validation (~1-3 min on first deploy).
    // ACM certs are immutable, so adding a redirect SAN replaces the cert: CDK
    // issues a new one, re-validates via DNS, then swaps it on the distribution.
    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: fqdn,
      subjectAlternativeNames: redirectFrom.length > 0 ? redirectFrom : undefined,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // Private bucket — accessed by CloudFront via OAC, never public.
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName: fqdn,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    // Runs on every viewer request (~sub-ms, $0.10/M), but only rewrites the
    // ones arriving on a retired hostname — the canonical host falls straight
    // through to the origin. Only created when there is something to redirect.
    const canonicalHostFn =
      redirectFrom.length > 0
        ? new cloudfront.Function(this, 'CanonicalHostRedirect', {
            runtime: cloudfront.FunctionRuntime.JS_2_0,
            comment: `301 retired hostnames to ${fqdn}`,
            code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  if (request.headers.host.value === '${fqdn}') return request;

  // Rebuild the query string: CloudFront hands it over parsed, and a redirect
  // that dropped it would silently break any deep link carrying one.
  var pairs = [];
  for (var key in request.querystring) {
    var param = request.querystring[key];
    if (param.multiValue) {
      for (var i = 0; i < param.multiValue.length; i++) {
        pairs.push(key + '=' + param.multiValue[i].value);
      }
    } else {
      pairs.push(param.value === '' ? key : key + '=' + param.value);
    }
  }
  var search = pairs.length > 0 ? '?' + pairs.join('&') : '';

  return {
    statusCode: 301,
    statusDescription: 'Moved Permanently',
    headers: {
      location: { value: 'https://${fqdn}' + request.uri + search },
    },
  };
}
`),
          })
        : undefined;

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
        functionAssociations: canonicalHostFn
          ? [
              {
                function: canonicalHostFn,
                eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
              },
            ]
          : undefined,
      },
      domainNames: [fqdn, ...redirectFrom],
      certificate,
      defaultRootObject: 'index.html',
      // S3 REST API (used with OAC) returns 403 for missing objects, not 404.
      // Both must redirect to index.html to support SPA deep links.
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // US, Canada, Europe — cheapest
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
    });

    // Sync the site's asset dir to S3 and invalidate CloudFront on every deploy.
    // For built apps, dist/ must exist before running cdk deploy (scripts/deploy.sh handles this).
    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(props.sourceDir)],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    // Alias record — free (no per-query charge unlike CNAME).
    new route53.ARecord(this, 'AliasRecord', {
      zone: hostedZone,
      recordName: props.subDomain,
      target: route53.RecordTarget.fromAlias(
        new targets.CloudFrontTarget(distribution)
      ),
    });

    // Retired names point at the same distribution, which 301s them. Construct
    // ids are derived from the hostname (not the index) so reordering or
    // dropping one entry never renames another's record.
    for (const retired of redirectFrom) {
      new route53.ARecord(this, `RedirectAliasRecord${pascalCase(retired)}`, {
        zone: hostedZone,
        recordName: retired,
        target: route53.RecordTarget.fromAlias(
          new targets.CloudFrontTarget(distribution)
        ),
      });
    }

    new cdk.CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new cdk.CfnOutput(this, 'DistributionDomain', { value: distribution.distributionDomainName });
    new cdk.CfnOutput(this, 'SiteUrl', { value: `https://${fqdn}` });
  }
}
