import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

interface StaticSiteProps extends cdk.StackProps {
  domainName: string;
  subDomain: string;
  hostedZoneId: string;
}

export class StaticSiteStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: StaticSiteProps) {
    super(scope, id, props);

    const fqdn = `${props.subDomain}.${props.domainName}`;

    // Import the existing hosted zone — does NOT create or manage it.
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.domainName,
    });

    // ACM cert with DNS validation. CDK auto-creates the Route 53 CNAME record
    // and waits for validation (~1-3 min on first deploy).
    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: fqdn,
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

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
      },
      domainNames: [fqdn],
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

    // Sync dist/ to S3 and invalidate CloudFront cache on every deploy.
    // dist/ must be built before running cdk deploy (scripts/deploy.sh handles this).
    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset('../dist')],
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

    new cdk.CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new cdk.CfnOutput(this, 'DistributionDomain', { value: distribution.distributionDomainName });
    new cdk.CfnOutput(this, 'SiteUrl', { value: `https://${fqdn}` });
  }
}
