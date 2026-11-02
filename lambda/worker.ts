// SQS(1メッセージ=1ファイル) -> 条件付き更新で取得 -> ダミーLLM(30s, 確率で429) -> CSVをS3 -> DONE
import type { SQSEvent, SQSBatchResponse, SQSRecord } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, ChangeMessageVisibilityCommand } from '@aws-sdk/client-sqs';
import { DynamoDBClient, ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const s3 = new S3Client({});
const sqs = new SQSClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const env = process.env as Record<string, string>;
const FAILURE_RATE = Number(env.FAILURE_RATE ?? '0.1');
const SLEEP = Number(env.LLM_SLEEP_SECONDS ?? '30');
const MAX_RECEIVE = Number(env.MAX_RECEIVE_COUNT ?? '3');

class RateLimitError extends Error { retryAfter = 10; constructor() { super('429 Too Many Requests (simulated)'); } }

async function dummyLlm(): Promise<string> {
  await new Promise((r) => setTimeout(r, SLEEP * 1000));
  if (Math.random() < FAILURE_RATE) throw new RateLimitError();
  return 'productCode,productName,quantity\nA-001,Widget,10\nB-002,Gadget,5\n';
}

const now = () => new Date().toISOString();

async function processRecord(rec: SQSRecord): Promise<void> {
  const body = JSON.parse(rec.body);
  if (body.Event === 's3:TestEvent') return; // S3通知設定時のテストイベント
  const s3rec = body.Records?.[0];
  if (!s3rec) return;
  const key = decodeURIComponent(s3rec.s3.object.key.replace(/\+/g, ' '));
  const jobId = key.replace(/^uploads\//, '').replace(/\.pdf$/, '');
  const receiveCount = Number(rec.attributes.ApproximateReceiveCount);

  // 冪等性: QUEUED/RETRYING の時だけ PROCESSING に遷移できる。DONE や他ワーカー処理中なら何もしない
  try {
    await ddb.send(new UpdateCommand({
      TableName: env.TABLE, Key: { jobId },
      UpdateExpression: 'SET #s = :p, updatedAt = :t, startedAt = if_not_exists(startedAt, :t) ADD attempts :one',
      ConditionExpression: 'attribute_exists(jobId) AND #s IN (:q, :r)',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':p': 'PROCESSING', ':q': 'QUEUED', ':r': 'RETRYING', ':t': now(), ':one': 1 },
    }));
  } catch (e) {
    if (e instanceof ConditionalCheckFailedException) {
      console.log(JSON.stringify({ msg: 'skip duplicate (idempotent)', jobId, receiveCount }));
      return; // 成功扱いでメッセージ削除
    }
    throw e;
  }

  try {
    const csv = await dummyLlm();
    const resultKey = `results/${jobId}.csv`; // jobIdキーで上書きのみ
    await s3.send(new PutObjectCommand({ Bucket: env.BUCKET, Key: resultKey, Body: csv, ContentType: 'text/csv' }));
    await ddb.send(new UpdateCommand({
      TableName: env.TABLE, Key: { jobId },
      UpdateExpression: 'SET #s = :d, resultKey = :k, updatedAt = :t, finishedAt = :t',
      ConditionExpression: '#s = :p',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':d': 'DONE', ':p': 'PROCESSING', ':k': resultKey, ':t': now() },
    }));
    console.log(JSON.stringify({ msg: 'done', jobId, receiveCount }));
  } catch (e) {
    const last = receiveCount >= MAX_RECEIVE;
    await ddb.send(new UpdateCommand({
      TableName: env.TABLE, Key: { jobId },
      UpdateExpression: 'SET #s = :s, lastError = :e, updatedAt = :t',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': last ? 'FAILED' : 'RETRYING', ':e': String(e), ':t': now() },
    }));
    console.warn(JSON.stringify({ msg: last ? 'failed -> DLQ' : 'retry', jobId, receiveCount, error: String(e) }));
    if (e instanceof RateLimitError && !last) {
      // Retry-After相当のバックオフ（可視性タイムアウト全体を待たない）
      await sqs.send(new ChangeMessageVisibilityCommand({
        QueueUrl: env.QUEUE_URL, ReceiptHandle: rec.receiptHandle, VisibilityTimeout: e.retryAfter * receiveCount,
      }));
    }
    throw e;
  }
}

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const failures: SQSBatchResponse['batchItemFailures'] = [];
  for (const rec of event.Records) {
    try { await processRecord(rec); } catch { failures.push({ itemIdentifier: rec.messageId }); }
  }
  return { batchItemFailures: failures };
};
