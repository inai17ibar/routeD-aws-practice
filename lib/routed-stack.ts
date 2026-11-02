import * as path from 'path';
import { Duration, RemovalPolicy, Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';

export interface RouteDProps extends StackProps {
  maxConcurrency: number; // SQSイベントソースの最大同時実行数 N (2..1000)
  failureRate: number;    // ダミー429の発生率 0..1
  llmSleepSeconds: number;
}

export class RouteDStack extends Stack {
  constructor(scope: Construct, id: string, props: RouteDProps) {
    super(scope, id, props);

    const workerTimeout = Duration.seconds(Math.max(60, props.llmSleepSeconds + 30)); // 30s超
    const visibility = Duration.seconds(workerTimeout.toSeconds() * 6);                // 6倍

    const bucket = new s3.Bucket(this, 'Bucket', {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED, // 本番はSSE-KMS（KMSは有料のため練習ではSSE-S3）
      enforceSSL: true,
      cors: [{ allowedMethods: [s3.HttpMethods.PUT], allowedOrigins: ['*'], allowedHeaders: ['*'] }],
      lifecycleRules: [{ expiration: Duration.days(1) }],
    });

    const table = new ddb.Table(this, 'Jobs', {
      partitionKey: { name: 'jobId', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });

    const dlq = new sqs.Queue(this, 'Dlq', {
      retentionPeriod: Duration.days(4),
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const queue = new sqs.Queue(this, 'Queue', {
      visibilityTimeout: visibility,
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    bucket.addEventNotification(s3.EventType.OBJECT_CREATED_PUT, new s3n.SqsDestination(queue),
      { prefix: 'uploads/', suffix: '.pdf' });

    const logGroup = (name: string) => new logs.LogGroup(this, `${name}Logs`, {
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const common = {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      bundling: { minify: true, externalModules: ['@aws-sdk/*'] },
    };

    const api = new nodejs.NodejsFunction(this, 'UploadApi', {
      ...common,
      entry: path.join(__dirname, '../lambda/upload-api.ts'),
      timeout: Duration.seconds(10),
      logGroup: logGroup('UploadApi'),
      environment: { BUCKET: bucket.bucketName, TABLE: table.tableName },
    });
    bucket.grantPut(api);
    table.grantReadWriteData(api);
    const url = api.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE }); // 練習用。本番はCognito/IAM

    const worker = new nodejs.NodejsFunction(this, 'Worker', {
      ...common,
      entry: path.join(__dirname, '../lambda/worker.ts'),
      timeout: workerTimeout,
      logGroup: logGroup('Worker'),
      environment: {
        BUCKET: bucket.bucketName, TABLE: table.tableName, QUEUE_URL: queue.queueUrl,
        FAILURE_RATE: String(props.failureRate),
        LLM_SLEEP_SECONDS: String(props.llmSleepSeconds),
        MAX_RECEIVE_COUNT: '3',
      },
    });
    bucket.grantReadWrite(worker);
    table.grantReadWriteData(worker);
    queue.grant(worker, 'sqs:ChangeMessageVisibility');
    worker.addEventSource(new SqsEventSource(queue, {
      batchSize: 1,
      maxConcurrency: props.maxConcurrency,
      reportBatchItemFailures: true,
    }));

    new CfnOutput(this, 'ApiUrl', { value: url.url });
    new CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new CfnOutput(this, 'TableName', { value: table.tableName });
    new CfnOutput(this, 'QueueUrl', { value: queue.queueUrl });
    new CfnOutput(this, 'DlqUrl', { value: dlq.queueUrl });
    new CfnOutput(this, 'WorkerName', { value: worker.functionName });
  }
}
