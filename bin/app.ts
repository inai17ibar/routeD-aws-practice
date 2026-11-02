#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RouteDStack } from '../lib/routed-stack';

const app = new cdk.App();
const num = (k: string, d: number) => Number(app.node.tryGetContext(k) ?? d);

new RouteDStack(app, 'RouteDPracticeStack', {
  maxConcurrency: num('maxConcurrency', 5),
  failureRate: num('failureRate', 0.1),
  llmSleepSeconds: num('llmSleepSeconds', 30),
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-1' },
});
