# route-D AWS 練習プロジェクト（FAX注文書PDF → CSV 非同期変換）

設計案: [docs/design.md](docs/design.md) / 構成図: [docs/system.png](docs/system.png)

```
クライアント ──POST──▶ UploadApi Lambda (Function URL) ──▶ DynamoDB Jobs (status=QUEUED)
     │                     └─ presigned PUT URL を返す
     └──PUT PDF──▶ S3 uploads/{jobId}.pdf ──S3イベント──▶ SQS (1ファイル=1メッセージ)
                                                         │ batchSize=1, maxConcurrency=N(既定5)
                                                         ▼               └ 3回失敗 → DLQ
                                                    Worker Lambda ── 条件付き更新 QUEUED/RETRYING→PROCESSING
                                                         │  ダミーLLM: 30秒sleep、10%で429
                                                         ▼
                                               S3 results/{jobId}.csv + DynamoDB DONE/FAILED
```

| 項目 | 値 |
|---|---|
| Worker タイムアウト | 60秒（sleep 30秒 + 余裕） |
| SQS 可視性タイムアウト | 360秒（= 6 × 60秒） |
| DLQ | maxReceiveCount = 3 |
| 429 時 | ChangeMessageVisibility で 10秒×受信回数 のバックオフ |
| ステータス | QUEUED → PROCESSING → DONE / RETRYING → … → FAILED |

コスト: NAT・VPC・KMS なし、DynamoDB オンデマンド、ログ保持1日、S3は1日で自動削除。30件テストを数回やっても無料枠内（≒$0）。

---

## 0. 前提（所要 30分）
- AWS アカウント（ルートではなく IAM Identity Center / IAM ユーザーで作業推奨）
- AWS CLI v2（`aws --version`）、認証設定済み（`aws sts get-caller-identity` が通る）
- Node.js 20 以上、npm
- リージョン: `ap-northeast-1`（東京）を想定

```bash
export AWS_REGION=ap-northeast-1 AWS_DEFAULT_REGION=ap-northeast-1
npm install
```

## Step 0. AWS Budgets で $1 アラートを設定（最初に必ず）
### コンソール
1. 「Billing and Cost Management」→「Budgets（予算）」→「予算を作成」
2. 「テンプレートを使用」→「月次コスト予算」（またはカスタム→コスト予算）
3. 予算名 `practice-1usd`、金額 `1.00` USD
4. 通知先メールアドレスを入力 → 作成（実績が 85%/100%、予測が100% でメール）

### AWS CLI
```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
EMAIL=you@example.com
aws budgets create-budget --account-id "$ACCOUNT_ID" \
  --budget '{"BudgetName":"practice-1usd","BudgetLimit":{"Amount":"1","Unit":"USD"},"TimeUnit":"MONTHLY","BudgetType":"COST"}' \
  --notifications-with-subscribers "[{\"Notification\":{\"NotificationType\":\"ACTUAL\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":80,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$EMAIL\"}]},{\"Notification\":{\"NotificationType\":\"FORECASTED\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":100,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$EMAIL\"}]}]"
aws budgets describe-budgets --account-id "$ACCOUNT_ID" --query 'Budgets[].BudgetName'
```
※ Budgets は請求データ反映に数時間の遅延あり。2つまで無料。

## Step 1. ビルド確認・bootstrap・デプロイ（所要 30分）
```bash
npx tsc --noEmit
npx cdk synth > /dev/null          # テンプレート生成確認（認証不要）
npx cdk bootstrap                  # アカウント×リージョンで初回のみ。CDKToolkit スタックが作られる
npx cdk deploy --outputs-file outputs.json
# 並列数・失敗率を変える場合:
npx cdk deploy -c maxConcurrency=10 -c failureRate=0.3 --outputs-file outputs.json
```
`outputs.json` に ApiUrl / BucketName / TableName / QueueUrl / DlqUrl / WorkerName が出力される。

便利な変数:
```bash
o() { node -e "console.log(require('./outputs.json').RouteDPracticeStack.$1)"; }
API=$(o ApiUrl); BUCKET=$(o BucketName); TABLE=$(o TableName); Q=$(o QueueUrl); DLQ=$(o DlqUrl); FN=$(o WorkerName)
```

単発動作確認:
```bash
R=$(curl -s -X POST "$API" -d '{"fileName":"a.pdf"}'); echo "$R"
JOB=$(echo "$R" | node -pe 'JSON.parse(require("fs").readFileSync(0)).jobId')
URL=$(echo "$R" | node -pe 'JSON.parse(require("fs").readFileSync(0)).uploadUrl')
printf '%%PDF-1.4 dummy' > /tmp/a.pdf
curl -s -X PUT -H 'Content-Type: application/pdf' --upload-file /tmp/a.pdf "$URL"
sleep 40; curl -s "$API?jobId=$JOB"; aws s3 cp "s3://$BUCKET/results/$JOB.csv" -
```

## Step 2. 30ファイル同時投入テスト（所要 15分）
```bash
npm run load-test          # = npx ts-node scripts/load-test.ts 30
```
出力例（N=5）:
```
uploaded 30 files in 2.1s
[  10s] PROCESSING=5 QUEUED=25
[  45s] DONE=5 PROCESSING=5 QUEUED=20
...
total 200s, DONE=30, FAILED=0
```
- 理論値は `ceil(30/N) × 30秒`。N=5 → 約3分、N=10 → 約1.5分、N=30 → 約30秒。
- `-c maxConcurrency=10` で再デプロイして再実行し、時間が縮むことを確認する。

## Step 3. CloudWatch で同時実行を観察（所要 30分）
- Lambda → Worker → 「モニタリング」: **ConcurrentExecutions** が N で頭打ちになる
- SQS → Queue → 「モニタリング」: `ApproximateNumberOfMessagesVisible`（待ち行列）が減っていく、`ApproximateAgeOfOldestMessage`
- CloudWatch Logs Insights（Worker のロググループ）:
```
fields @timestamp, msg, jobId, receiveCount, error
| filter ispresent(msg) | sort @timestamp desc
```
- CLI でメトリクス:
```bash
aws cloudwatch get-metric-statistics --namespace AWS/Lambda --metric-name ConcurrentExecutions \
  --dimensions Name=FunctionName,Value=$FN --statistics Maximum --period 60 \
  --start-time $(date -u -d '-30 min' +%FT%TZ) --end-time $(date -u +%FT%TZ)
```

## Step 4. 429 リトライと DLQ（所要 30分）
```bash
npx cdk deploy -c failureRate=0.5 --outputs-file outputs.json   # 50%で429
npm run load-test
```
- ログに `retry`（receiveCount=1,2）と `failed -> DLQ`（receiveCount=3）が出る
- DynamoDB: `attempts` が増え、3回とも失敗したジョブは `FAILED`
- DLQ 確認:
```bash
aws sqs get-queue-attributes --queue-url "$DLQ" --attribute-names ApproximateNumberOfMessages
aws sqs receive-message --queue-url "$DLQ" --max-number-of-messages 1
```
- redrive（DLQ→元キューへ戻す）: コンソールの DLQ 画面「DLQ 再処理の開始」、または
```bash
aws sqs start-message-move-task --source-arn $(aws sqs get-queue-attributes --queue-url "$DLQ" --attribute-names QueueArn --query Attributes.QueueArn --output text)
```
  ※ FAILED のジョブは条件付き更新で弾かれる（スキップ）。再処理させたい場合は先に status を RETRYING に戻す:
  `aws dynamodb update-item --table-name $TABLE --key "{\"jobId\":{\"S\":\"$JOB\"}}" --update-expression 'SET #s=:r' --expression-attribute-names '{"#s":"status"}' --expression-attribute-values '{":r":{"S":"RETRYING"}}'`
- 確認後 `npx cdk deploy -c failureRate=0.1 ...` に戻す。

## Step 5. 冪等性チェック（同じメッセージを再送）（所要 15分）
SQS は「少なくとも1回」配信なので、同じ S3 イベントを手動で再送して二重処理されないことを確認する。
```bash
cat > /tmp/dup.json <<JSON
{"Records":[{"s3":{"bucket":{"name":"$BUCKET"},"object":{"key":"uploads/$JOB.pdf"}}}]}
JSON
aws sqs send-message --queue-url "$Q" --message-body file:///tmp/dup.json
```
- DONE 済みジョブ: ログに `skip duplicate (idempotent)`、`attempts` は増えない、LLM（sleep）は呼ばれない
- 処理中に同時に2通送った場合も、条件付き更新に勝った1つだけが PROCESSING になる

## Step 6. 片付け（所要 15分）
```bash
npx cdk destroy            # S3は autoDeleteObjects で中身ごと削除、テーブル・キュー・ロググループも DESTROY
```
残っていないことを確認:
```bash
aws cloudformation describe-stacks --stack-name RouteDPracticeStack   # → does not exist
aws s3 ls | grep -i routed
aws dynamodb list-tables
aws sqs list-queues
aws lambda list-functions --query 'Functions[].FunctionName'
aws logs describe-log-groups --query 'logGroups[].logGroupName' | grep -i routed
```
- **CDK bootstrap スタック（CDKToolkit）は destroy では消えない。** 中の `cdk-hnb659fds-assets-<account>-<region>` S3 バケット（Lambdaのzip等）と ECR リポジトリが残る。数MB なので月 $0.01 未満だが、完全に消すなら:
```bash
aws s3 rm s3://cdk-hnb659fds-assets-$ACCOUNT_ID-$AWS_REGION --recursive
# バージョニング有効のため、残る場合はコンソールで「空にする」
aws cloudformation delete-stack --stack-name CDKToolkit
```
  （他の CDK プロジェクトで使っている場合は消さない）
- 翌日以降、Cost Explorer で請求が $0 付近であることを確認。Budgets は残しておいてよい。

---

## 面接での話のポイント
1. **流量制御は SQS イベントソースの maxConcurrency=N**。予約同時実行数だとスロットリング→リトライが発生し得るが、maxConcurrency はポーラー側で制御するので待ち行列として SQS に溜まるだけ。N は LLM の RPM/TPM/並列上限から算出（実測: 30件 = ceil(30/N)×30秒）。
2. **タイムアウト設計**: 可視性タイムアウト ≥ 6×Lambdaタイムアウト（AWS推奨）。処理中に別ワーカーが同じメッセージを掴まないため。
3. **エラー分類**: 429/5xx はリトライ（Retry-After 相当で ChangeMessageVisibility）、3回で DLQ→アラーム→redrive。破損PDFなど恒久エラーはリトライせず即 FAILED。ReportBatchItemFailures で部分失敗のみ再試行。
4. **冪等性**: at-least-once 配信前提。DynamoDB の条件付き更新（QUEUED/RETRYING→PROCESSING）で LLM 呼び出しを1回に、結果は jobId キー上書きのみ。
5. **非同期 UX**: presigned URL で API を大容量通過させない。状態は DB に永続化、画面はポーリング（将来 WebSocket）。
6. **コスト**: 支配的なのは LLM 料金。N・リトライ回数・Budgets で上限管理。インフラはサーバレス従量課金でアイドル時ほぼ $0。
7. **本番との差分**（練習版で省略したもの）: Cognito 認証（Function URL は認証なし）、SSE-KMS、Secrets Manager、DLQ アラーム→SNS、顧客ID×日時の GSI/複合キー、PROCESSING のままのジョブ回収（ハートビート/タイムアウト判定）、Content-Length 制限（presigned POST）、Step Functions への拡張。

## ファイル構成
```
bin/app.ts             CDK アプリ（context: maxConcurrency / failureRate / llmSleepSeconds）
lib/routed-stack.ts    スタック定義
lambda/upload-api.ts   ジョブ作成 + presigned URL 発行（GET ?jobId= で状態取得）
lambda/worker.ts       SQS ワーカー（条件付き更新・ダミーLLM・429・CSV出力）
scripts/load-test.ts   30件同時投入 + 状態ポーリング
docs/                  設計書・構成図
```
