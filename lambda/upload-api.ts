// POST {fileName?} -> ジョブ作成(status=QUEUED) + presigned PUT URL を返す
import { randomUUID } from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const { BUCKET, TABLE } = process.env as Record<string, string>;

export const handler = async (event: any) => {
  const method = event.requestContext?.http?.method;
  if (method === 'GET') { // GET ?jobId=xxx で状態確認
    const jobId = event.queryStringParameters?.jobId;
    const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: { jobId } }));
    return { statusCode: r.Item ? 200 : 404, body: JSON.stringify(r.Item ?? { error: 'not found' }) };
  }
  const body = event.body ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body) : {};
  const jobId = randomUUID();
  const key = `uploads/${jobId}.pdf`;
  const now = new Date().toISOString();
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      jobId, status: 'QUEUED', fileName: body.fileName ?? 'unknown.pdf', s3Key: key,
      promptVersion: 'v1', // ジョブ作成時に版を固定
      createdAt: now, updatedAt: now, attempts: 0,
      ttl: Math.floor(Date.now() / 1000) + 86400,
    },
    ConditionExpression: 'attribute_not_exists(jobId)',
  }));
  const uploadUrl = await getSignedUrl(s3,
    new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: 'application/pdf' }), { expiresIn: 300 });
  return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId, key, uploadUrl }) };
};
