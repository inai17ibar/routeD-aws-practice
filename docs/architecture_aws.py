"""AWS公式アイコン版の構成図。実行: python3 architecture_aws.py (graphviz の dot が PATH に必要)"""
from diagrams import Cluster, Diagram, Edge
from diagrams.aws.compute import Lambda
from diagrams.aws.database import Dynamodb
from diagrams.aws.storage import S3
from diagrams.aws.integration import SQS
from diagrams.aws.management import Cloudwatch
from diagrams.aws.cost import Budgets
from diagrams.onprem.client import Client

F = "Noto Sans CJK JP"
with Diagram("route-D 非同期PDF→CSV変換", filename="architecture-aws", outformat="png", show=False,
             direction="LR", graph_attr={"fontname": F, "fontsize": "20", "pad": "0.5", "nodesep": "0.8", "ranksep": "1.2", "splines": "spline"},
             node_attr={"fontname": F, "fontsize": "12"}, edge_attr={"fontname": F, "fontsize": "11"}):
    client = Client("クライアント\n(負荷テスト)")
    with Cluster("AWS Cloud (ap-northeast-1)", graph_attr={"fontname": F, "fontsize": "14"}):
        api = Lambda("upload-api\n(Function URL)")
        db = Dynamodb("DynamoDB Jobs\nQUEUED→PROCESSING→\nDONE/RETRYING/FAILED")
        s3in = S3("S3 入力\nuploads/{jobId}.pdf")
        q = SQS("SQS\n1ファイル=1メッセージ")
        dlq = SQS("DLQ\nmaxReceiveCount=3")
        worker = Lambda("worker\nbatch=1, N=5\nダミーLLM 30秒/10%で429")
        s3out = S3("S3 結果\nresults/{jobId}.csv")
        cw = Cloudwatch("CloudWatch\nLogs/Metrics")
        bud = Budgets("AWS Budgets\n$1 アラート")

    client >> Edge(label="1. POST ジョブ作成") >> api
    api >> Edge(label="2. QUEUED 登録") >> db
    api >> Edge(label="3. presigned URL", style="dashed", constraint="false") >> client
    client >> Edge(label="4. PUT ファイル") >> s3in
    s3in >> Edge(label="5. S3イベント") >> q
    q >> Edge(label="6. 受信 batch=1") >> worker
    worker >> Edge(label="7. 条件付き更新\nPROCESSING→DONE/RETRYING") >> db
    worker >> Edge(label="8. 結果CSV") >> s3out
    worker >> Edge(label="429 再試行\n遅延 10秒×受信回数", style="dashed", color="darkorange", constraint="false") >> q
    q >> Edge(label="9. 3回受信後 → DLQ", style="dashed", color="firebrick") >> dlq
    [api, worker] >> Edge(style="dotted", color="gray", constraint="false") >> cw
