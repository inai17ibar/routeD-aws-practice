// 30ファイルを同時アップロードし、DynamoDBをポーリングして状態件数と経過時間を表示
// 使い方: npx ts-node scripts/load-test.ts [件数=30]   (outputs.json を読む)
import * as fs from 'fs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchGetCommand } from '@aws-sdk/lib-dynamodb';

const outputs = JSON.parse(fs.readFileSync('outputs.json', 'utf8')).RouteDPracticeStack;
const API: string = outputs.ApiUrl;
const TABLE: string = outputs.TableName;
const N = Number(process.argv[2] ?? 30);
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const pdf = Buffer.from('%PDF-1.4\n% dummy FAX order\n%%EOF\n');

async function uploadOne(i: number): Promise<string> {
  const r = await fetch(API, { method: 'POST', body: JSON.stringify({ fileName: `order-${i}.pdf` }) });
  const { jobId, uploadUrl } = (await r.json()) as { jobId: string; uploadUrl: string };
  const put = await fetch(uploadUrl, { method: 'PUT', body: pdf, headers: { 'Content-Type': 'application/pdf' } });
  if (!put.ok) throw new Error(`PUT failed ${put.status}`);
  return jobId;
}

async function fetchAll(ids: string[]) {
  const items: any[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const r = await ddb.send(new BatchGetCommand({ RequestItems: { [TABLE]: { Keys: ids.slice(i, i + 100).map((jobId) => ({ jobId })) } } }));
    items.push(...(r.Responses?.[TABLE] ?? []));
  }
  return items;
}

(async () => {
  const t0 = Date.now();
  const ids = await Promise.all(Array.from({ length: N }, (_, i) => uploadOne(i)));
  console.log(`uploaded ${ids.length} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  fs.writeFileSync('last-jobs.json', JSON.stringify(ids, null, 2));
  for (;;) {
    const items = await fetchAll(ids);
    const c: Record<string, number> = {};
    items.forEach((it) => (c[it.status] = (c[it.status] ?? 0) + 1));
    const sec = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`[${sec.padStart(4)}s] ${Object.entries(c).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    if ((c.DONE ?? 0) + (c.FAILED ?? 0) >= N) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  const items = await fetchAll(ids);
  const done = items.filter((i) => i.finishedAt);
  const dur = done.map((i) => (Date.parse(i.finishedAt) - Date.parse(i.createdAt)) / 1000);
  console.log(`\ntotal ${((Date.now() - t0) / 1000).toFixed(0)}s, DONE=${done.length}, FAILED=${items.length - done.length}`);
  if (dur.length) console.log(`per-job createdAt->finishedAt: min ${Math.min(...dur).toFixed(0)}s / max ${Math.max(...dur).toFixed(0)}s`);
  console.log(`retried jobs (attempts>1): ${items.filter((i) => i.attempts > 1).length}`);
  console.log(`理論値: ceil(${N}/N) x 30s 程度（N=maxConcurrency）。リトライがあると延びる。`);
})();
