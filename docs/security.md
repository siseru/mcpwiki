# セキュリティ設計と脅威モデル

## 守る対象

- 記事の機密性（`readScope`）と完全性（`writeScope`、履歴）
- アカウント（MFA、トークン）
- 運用基盤（AWS リソースとデプロイ経路）

## 認証

- Cognito User Pool で MFA を必須にしています（TOTP のみ。SMS は SIM スワップの危険があるため使いません）。セルフサインアップは無効で、管理者による招待制です。パスワードは 12 文字以上で、4 種類の文字をすべて含む必要があります。
- 認可コードフローと PKCE を使います（Web と CLI はどちらも secret を持たない public client です）。アクセストークンの有効期限は 1 時間、リフレッシュトークンは Web で 12 時間、CLI で 7 日です。トークンの失効 (revocation) を有効にしています。
- アクセストークンは Lambda の中で検証します（`src/backend/auth.ts`）。検証するのは RS256 署名（JWKS）、`iss`、`token_use=access`、`exp` / `iat`、そして `client_id` が許可リストに含まれていることです。
- ロール変更やアカウント無効化を行うと、DynamoDB の `minIat` を更新します。これにより、その時点より前に発行されたトークンは即座に拒否されます（Cognito のアクセストークンはオフラインで検証されるため、この仕組みがないと最大 1 時間有効なままになります）。
- Web のトークンは `sessionStorage`（タブ単位）に置きます。`localStorage` の使用は lint で禁止しています。

## 認可

- 判定は `src/shared/permissions.ts` の 1 か所だけで行います。テストでは、ロール 3 種 × オーナーかどうか × 閲覧範囲 × 編集範囲 × 削除済みかどうかの全組み合わせを確認しています。
- 閲覧できない記事は 404 を返し、存在を明かしません。検索、タグ、グラフ、バックリンクでも同じ判定で除外します。
- 削除、復元、レビュー、ユーザ管理、インポートは、Web 用クライアントのトークンに限っています（CLI / MCP のトークンでは 403）。
- MCP からの権限の拡大は拒否します。
- 入力は `src/shared/validate.ts` で検証します。サイズ上限、制御文字の禁止、タグの文字種、拡張キーの予約語を確認します。

## Web (XSS / クリックジャッキング)

- Markdown を marked で HTML に変換したあと、DOMPurify で `style` / `form` / `iframe` / `svg` などを除去し、さらに CSP（`script-src 'self'`、inline スクリプト不可、`object-src 'none'`、`frame-ancestors 'none'`、`base-uri 'none'`）で三重に防ぎます。
- 画面の組み立てはすべて `textContent` 経由で行います。`innerHTML` などは lint で禁止しています。
- 外部リンクには `rel="noopener noreferrer nofollow"` を付け、外部画像の取得時はリファラを送りません。
- HSTS、`X-Content-Type-Options`、`X-Frame-Options: DENY`、`Referrer-Policy`、`Permissions-Policy`、`COOP` を付けています。

## MCP / LLM 固有の脅威

| 脅威 | 対策 |
|---|---|
| 記事本文に仕込まれたプロンプトインジェクション | 応答で本文を `trust="untrusted"` として区切り、server instructions で「データとして扱う」よう明示します |
| インジェクションによる権限拡大や記事の公開 | MCP からの権限拡大を禁止しています |
| インジェクションによる記事削除 | MCP に削除ツールがなく、サーバー側でも Web 以外からの削除を拒否します |
| LLM による上書き事故 | 楽観ロック（`version` 必須）、S3 のバージョン履歴、MCP から作成した記事は既定で draft、`generated.by` で出所を記録 |
| 大量の呼び出し | ユーザ単位のレート制限（全体 300 回/分、書き込み 60 回/分）、API Gateway のスロットリング、WAF のレート制限 |
| DNS リバインディング | `/mcp` で `Origin` ヘッダを検証します |

## インフラ

- S3 は全バケットでパブリックアクセスをブロックし、SSL を強制、暗号化しています。Web バケットへのアクセスは CloudFront OAC のみです。
- API Gateway を直接呼ばれると WAF を迂回されるため、CloudFront だけが付ける秘密ヘッダ（`x-origin-verify`、Secrets Manager で生成）を Lambda で検証し、直接のアクセスを拒否しています。
- Lambda の IAM は最小権限です。S3 は `articles/*` に対する Put / Get / GetVersion だけで削除権限はなく、履歴は Lambda からは消せません。DynamoDB は使う操作だけ、Cognito は必要な Admin API だけ、SSM はパラメータ 1 つだけに限っています。
- DynamoDB は PITR を有効にし、prod では削除保護と RETAIN を設定しています。
- ログ: Lambda の構造化ログ（トークンと本文は記録せず、lint で検査）、API のアクセスログ、CloudFront のアクセスログ、S3 のアクセスログ、監査ログ（DynamoDB、保持 400 日）。
- アラーム: Lambda のエラーとスロットル、API の 5xx、4xx の急増。
- CI は GitHub OIDC で認証します（長期のアクセスキーは使いません）。ロールは Environment 単位で `sub` を限定し、prod には承認者を必須にしています。cdk-nag（AwsSolutions）の指摘は、すべて理由を記録したうえで承認しています。

## 既知の制約とトレードオフ

- Cognito Plus（脅威保護、侵害された認証情報の検出）は、コストの都合で使っていません。必要になったら `featurePlan` を変更してください。
- dev と prod は同じ AWS アカウントに置いています（ユーザの指定によるものです）。境界はロールとリソースの分離です。
- 独自ドメインを設定しない場合（`*.cloudfront.net`）は、TLS ポリシーを固定できません。独自ドメインを設定すると、`TLSv1.2_2021`、ACM の自動更新、ログイン画面の同一ドメイン化（`auth.<host>`）が有効になります。
- 検索の転置インデックスは記事の保存時に同期更新します。失敗した場合は記事の保存を優先してエラーログを残すので、管理画面の「再構築」で復旧してください。
