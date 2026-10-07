# MCPWiki

LLM / MCP から使うことを前提にした、軽量なサーバーレス Wiki です。

- 人は **Web 画面**、LLM は **MCP**、スクリプトは **CLI / REST API** から、同じ権限モデルで閲覧・投稿・編集・検索・一覧ができます。
- 記事は **GitHub 互換の Markdown (GFM)** に [**OKF (Open Knowledge Format) v0.2**](https://github.com/GoogleCloudPlatform/open-knowledge-format) の frontmatter を付けた形で保存します。そのまま OKF バンドルとして入出力できます。
- 記事間のリンクとタグから**ナレッジグラフ**を作り、MCP (`get_graph`, `get_backlinks`) に提供します。
- AWS のサーバーレス構成（常時課金リソースなし）で、**MFA 必須**、**最小権限**、**多層防御**を前提に設計しています。

## アーキテクチャ

```
                 ┌──────────── CloudFront (+ WAF: prod) ─────────────┐
 Browser ───────▶│ /            → S3 (SPA, OAC)                      │
 CLI / MCP ─────▶│ /api/* /mcp  → API Gateway HTTP API → Lambda ─────┼─▶ DynamoDB (メタデータ/検索/グラフ/監査)
                 └───────────────────────────────────────────────────┘   S3 (記事本文 = OKF 文書, バージョニング = 履歴)
                          ▲ 認証: Cognito User Pool (MFA 必須, PKCE)       Cognito (ユーザ/グループ)
```

| 役割 | サービス | 備考 |
|---|---|---|
| 認証 | Cognito User Pool (Essentials) | TOTP MFA 必須、セルフサインアップ無効（管理者が招待）、グループ `admin` / `editor` / `viewer` |
| API / MCP | API Gateway HTTP API + Lambda (Node.js 24, arm64) | 1 関数で REST と MCP Streamable HTTP を処理します。JWT は Lambda 内で検証します |
| データ | DynamoDB (on-demand, PITR) | シングルテーブル構成。検索の転置インデックス、リンク、履歴、監査ログ、レート制限を持ちます |
| 本文 | S3 (versioning) | `articles/<id>.md` に OKF 文書を置きます。S3 のバージョンが記事の履歴を兼ねます。Lambda には削除権限を与えていません |
| 配信 | CloudFront + S3 (OAC) | CSP / HSTS などのセキュリティヘッダを付けます。API は秘密ヘッダ付きのオリジンでのみ受け付けます |
| 防御 | AWS WAF (prod) | IP レート制限、AWS マネージドルール（Common / KnownBadInputs / IP reputation） |

検索は OpenSearch を使わず、DynamoDB に置いた自前の転置インデックス（日本語は文字 bigram、英数字は単語単位）で行います。グラフも Neptune を使わず DynamoDB で持ちます。どちらもコストを抑えるための選択です。

### 外部依存

実行時に使う外部ライブラリは、ブラウザでの Markdown 描画に使う `marked` と、XSS 対策の `DOMPurify` の 2 つだけです（`npm run lint` で機械的に検査しています）。YAML (frontmatter) パーサ、JWT 検証、ZIP 入出力、MCP サーバ、CLI はすべて Node 標準機能で自作しています。Lambda で使う AWS SDK v3 は、Lambda ランタイムに同梱されているものです。

## 権限モデル

記事ごとに「閲覧範囲」と「編集範囲」を設定します（実装は `src/shared/permissions.ts` の 1 か所だけで、API、MCP、画面のすべてがこれを使います）。

| 設定 | 値 |
|---|---|
| 閲覧 `readScope` | `admin` 管理者のみ / `owner` オーナー（作成者）のみ / `all` だれでも（ログインユーザ） |
| 編集 `writeScope` | `none` 読み取りのみ / `admin` 管理者のみ / `owner` オーナーのみ / `all` 投稿者全員 |

- 管理者 (admin) は常に閲覧・編集できます。閲覧者 (viewer) はどの記事も編集できません。新規作成は投稿者 (editor) 以上ができます。
- 編集範囲を閲覧範囲より広くすることはできません。
- 閲覧できない記事は、一覧・検索・タグ・グラフ・バックリンクのどこにも現れません。直接アクセスしても 404 になり、存在自体が分からないようにしています。
- **削除は Web 画面からのみ**行えます（オーナーまたは管理者による論理削除で、管理者は復元できます）。MCP と CLI には削除機能がありません。加えてサーバー側でも、Web 用クライアントが発行したトークン以外からの削除を拒否します。
- **MCP からは権限を広げられません**（狭めることはできます）。プロンプトインジェクションによって記事が公開されてしまうのを防ぐためです。
- 編集は**楽観ロック**です。読んだときの `version` を付けて更新し、他の人が先に更新していれば 409 になります。

## セットアップ

前提: Node.js 20 以上（CI は 24 で実行）、AWS CLI、CDK bootstrap 済みのアカウント（prod は us-east-1 も bootstrap が必要です。WAF を置くため）。

```bash
npm ci
npm test                 # 単体テストと結合テスト（API / MCP / CLI を E2E で確認）
npm run lint             # セキュリティポリシーの静的チェック
npm run deploy:dev       # = npm run build && cdk deploy MCPWiki-dev-edge MCPWiki-dev
```

デプロイ後、出力される `Url` が Wiki の URL です。最初の管理者は次のコマンドで招待します。

```bash
scripts/create-admin.sh dev <username> <email> admin
```

招待メールの仮パスワードでサインインし、パスワードを変更して TOTP を登録します。以降のユーザは管理画面（`/admin`）から招待できます。

### 独自ドメイン (Route 53 / ACM)

`config/domains.example.json` をコピーして `config/domains.local.json` を作ります。このファイルは Git 管理外です。

```json
{ "zoneName": "example.com", "hostedZoneId": "Z0123456789EXAMPLE", "hosts": { "dev": "wiki-dev.example.com", "prod": "wiki.example.com" } }
```

ホストを設定した環境では、次のように構成されます。

- us-east-1 の `MCPWiki-<env>-edge` が、`<host>` と `auth.<host>` を 1 枚でカバーする ACM 証明書を発行します。検証は Route 53 の DNS 検証です。検証用のレコードは残し続けるので、ACM が期限前に**自動で更新**します。
- 証明書の残り日数が 30 日を切るとアラームが鳴ります（自動更新の失敗に気付くため）。
- CloudFront は `<host>` で配信し、TLS は `TLSv1.2_2021` 以上に限定します。Route 53 に A / AAAA のエイリアスを作ります。
- ログイン画面は `auth.<host>`（Cognito の独自ドメイン）になります。
- 既定の `*.cloudfront.net` へのアクセスは、`<host>` へ 308 でリダイレクトします。コールバック URL、CSP、MCP の Origin 検証も `<host>` だけを許可します。

CI では、同じ JSON を GitHub Environment 変数の `MCPWIKI_DOMAINS` に入れます。ファイルも変数も無ければ、`*.cloudfront.net` のまま動作します。

アラームの通知先を設定する場合は `-c alarmEmail=ops@example.com` を付けてデプロイします。リージョンは `cdk.json` の `context.region`（既定 `us-west-2`）で変えられます。

### 本番 (prod)

```bash
npm run deploy:prod      # MCPWiki-prod-edge (us-east-1: 証明書と WAF) と MCPWiki-prod
```

prod では、DynamoDB、S3、User Pool に削除保護と RETAIN を設定し、スタックには削除保護 (termination protection) を付けています。

## CI/CD (GitHub Actions)

| ワークフロー | 契機 | 内容 |
|---|---|---|
| `ci.yml` | PR / main への push | lint、型検査、テスト、`cdk synth`（cdk-nag AwsSolutions チェックを含む）、`npm audit` |
| `codeql.yml` | PR / push / 毎週 | CodeQL (security-extended) |
| `deploy.yml` | main への push → dev、`v*` タグ → prod | OIDC で AWS ロールを引き受けてデプロイし、スモークテストを実行 |

初回だけ、次の手順が必要です。

1. OIDC のデプロイロールを作ります: `npm run build && npx cdk deploy MCPWiki-ci -c githubRepo=<owner>/<repo>`
   （アカウントに GitHub OIDC プロバイダが既にある場合は `-c githubOidcProviderArn=...` を付けます）
2. GitHub の Settings → Environments で `dev` と `prod` を作り、それぞれの Environment 変数を設定します。
   - `AWS_DEPLOY_ROLE_ARN`: スタック出力の `DeployRoleArndev` / `DeployRoleArnprod`
   - `AWS_REGION`: 例 `us-west-2`
   - `MCPWIKI_DOMAINS`:（独自ドメインを使う場合）`config/domains.local.json` と同じ JSON
3. `prod` Environment に **Required reviewers** を設定します（本番デプロイに承認を必須にします）。
4. main ブランチを保護します（PR 必須、CI の成功を必須に）。

デプロイロールは Environment 単位で OIDC の `sub` を限定しているので、他のブランチやワークフローからは引き受けられません。権限は CDK bootstrap ロールの AssumeRole だけです。
なお dev と prod は同じアカウントに置く構成なので、両者の権限境界は IAM ロールとリソースの分離で作っています。より強く分けたい場合は、アカウントを分けることを推奨します。

## CLI

```bash
npm run build
install -m 755 dist/cli/mcpwiki.mjs ~/.local/bin/mcpwiki     # 依存なしの単一ファイル

mcpwiki configure --env dev --url https://dxxxxxxxx.cloudfront.net
mcpwiki login                     # ブラウザで MFA 付きサインイン (PKCE)
mcpwiki list --tag aws
mcpwiki search 東京タワー
mcpwiki get <id>                  # OKF 文書（frontmatter + Markdown）を出力
mcpwiki create --title "手順書" --tags ops,aws --file doc.md
mcpwiki edit <id>                 # $EDITOR で OKF 文書を編集（楽観ロック付き）
mcpwiki graph <id> --depth 2 --tags
mcpwiki export --out bundle.zip   # 自分が読める記事の OKF バンドル
```

ブラウザが別のマシンにある場合（SSH 先など）は、サインイン後に表示される `http://localhost:53682/callback?...` の URL をそのまま CLI に貼り付けてください。
トークンは `~/.config/mcpwiki/credentials.json`（パーミッション 0600）に保存し、自動で更新します（リフレッシュトークンの有効期限は 7 日です）。

## MCP

### Claude Code（stdio、推奨）

```bash
mcpwiki login --env dev
claude mcp add mcpwiki -- mcpwiki mcp --env dev
```

`mcpwiki mcp` は、stdio とリモートの `/mcp` エンドポイントの間を中継するだけのブリッジです。トークンの更新は CLI が行います。

### リモート (Streamable HTTP)

エンドポイントは `https://<distribution>/mcp` です。未認証のリクエストには、RFC 9728 の `WWW-Authenticate: Bearer resource_metadata=...` を付けて 401 を返します。認可サーバは Cognito で、PKCE を使い、クライアントは事前登録方式です（動的クライアント登録 DCR には未対応）。OAuth に対応したクライアントからは、`config.json` に載っている `cliClientId` と、コールバック `http://localhost:53682/callback` を指定して接続できます。

### ツール

| ツール | 内容 |
|---|---|
| `list_articles` | 一覧（タグ、自分の記事で絞り込み、カーソルでページング） |
| `get_article` | OKF 文書として取得（過去の版も取得可） |
| `search_articles` | 全文検索（スニペット付き） |
| `create_article` | 作成（MCP から作成した記事は既定で `status: draft`） |
| `update_article` | 部分更新（`version` 必須） |
| `list_tags` | タグと件数 |
| `get_graph` | 関連グラフ（`link` は有向、`tag` は無向で共通タグを表す） |
| `get_backlinks` | 被リンク一覧 |

記事の本文はユーザが書いた**信頼できないデータ**なので、MCP の応答では明示的に区切って返します。

## OKF について

記事は OKF の concept 文書として保存します。

```markdown
---
type: Wiki Article
title: 東京タワーの歴史
description: 1958 年完成の電波塔の概要
tags: [観光, 歴史]
status: stable
generated: { by: "human:taro", at: "2026-10-07T00:00:00.000Z" }
verified:
  - by: "human:hanako"
    at: "2026-10-08T00:00:00.000Z"
mcpwiki: { id: tokyo-tower, owner: taro, read_scope: all, write_scope: owner, version: 3, ... }
---

本文…… [関連記事](/wiki/other-article)
```

- 記事間のリンクは `[表示名](/wiki/<id>)` と書きます。OKF の `/wiki/<id>.md` 形式や、相対パスの `<id>.md` も認識します。
- `generated.by` には、Web と CLI からの編集なら `human:<ユーザ名>`、MCP からの編集なら `mcpwiki-mcp/<version>` を入れます。
- Web 画面の「レビュー済みにする」を押すと、`verified` に `human:<ユーザ名>` が追加されます（OKF の trust tier: human-reviewed）。内容が変わると `verified` はリセットされます。
- 拡張キー（`stale_after` など）は、取り込みや編集をしても保持されます。
- エクスポートされるバンドルは `index.md`（`okf_version: "0.2"`）と `wiki/<id>.md` で構成されます。

## コスト目安

小規模（数十ユーザ、数千記事）であれば、dev は月数ドルで収まります。prod は WAF（Web ACL と 4 つのルールで月 9 ドル前後）を加えて、月 10〜20 ドル程度の見込みです。常時起動のリソースはありません。

## ディレクトリ

```
src/shared   権限、OKF、YAML サブセット、トークン化、入力検証（API / Web / CLI で共通）
src/backend  Lambda: ルーティング、JWT 検証、業務ロジック、MCP、DynamoDB/S3 ストア、ZIP
src/web      SPA（ユーザ画面と管理画面）
src/cli      mcpwiki CLI と MCP stdio ブリッジ
src/infra    CDK (WikiStack / WafStack / CiStack)
test         node:test（メモリストアを使った API / MCP / CLI の E2E を含む）
scripts      build / lint / smoke / create-admin
docs         設計資料
```

詳しいセキュリティ設計は [docs/security.md](docs/security.md) を参照してください。

## ライセンス

MIT
