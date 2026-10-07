# MCPWiki

[English](README.en.md) | 日本語

LLM / MCP から使うことを前提にした、軽量なサーバーレス Wiki です。

- 人は **Web 画面**、LLM は **MCP**、スクリプトは **CLI / REST API** から、同じ権限モデルで閲覧・投稿・編集・検索・一覧ができます。
- 記事は **GitHub 互換の Markdown (GFM)** に [**OKF (Open Knowledge Format) v0.2**](https://github.com/GoogleCloudPlatform/open-knowledge-format) の frontmatter を付けた形で保存します。そのまま OKF バンドルとして入出力できます。
- 記事間のリンクとタグから**ナレッジグラフ**を作り、MCP (`get_graph`, `get_backlinks`) に提供します。
- AWS のサーバーレス構成（常時課金リソースなし）で、**MFA 必須**、**最小権限**、**多層防御**を前提に設計しています。CI/CD には継続的なセキュリティレビューを組み込んでいます。

## アーキテクチャ

![MCPWiki runtime architecture](docs/images/architecture.png)

| 役割 | サービス | 備考 |
|---|---|---|
| DNS / 証明書 | Route 53 + ACM (us-east-1) | `<host>` と `auth.<host>` を 1 枚の証明書でカバーします。DNS 検証なので自動で更新されます。CAA で発行元を Amazon に限定しています |
| 配信 | CloudFront + S3 (OAC) | TLS 1.2 以上、CSP / HSTS などを付けます。`*.cloudfront.net` へのアクセスは正規のホストへリダイレクトします |
| 防御 | AWS WAF (prod) | IP レート制限、AWS マネージドルール、ログ出力（認証ヘッダは伏せ字） |
| 認証 | Cognito User Pool (Essentials, managed login) | TOTP MFA 必須、招待制、グループ `admin` / `editor` / `viewer` |
| API / MCP | API Gateway HTTP API + Lambda (Node.js 24, arm64) | 1 つの関数で REST と MCP Streamable HTTP を処理します。JWT は Lambda 内で検証します |
| データ | DynamoDB (on-demand, PITR) | メタデータ、検索の転置インデックス、リンク（グラフ）、履歴、監査ログ、レート制限 |
| 本文 | S3 (versioning) | `articles/<id>.md` に OKF 文書を置き、S3 のバージョンが履歴を兼ねます。Lambda には削除権限を与えていません |
| バックアップ | AWS Backup (prod) | 毎日取得して 35 日保持します。ボールトにはロック（最低 7 日）を掛けています |

検索は OpenSearch を使わず、DynamoDB に置いた自前の転置インデックス（日本語は文字 bigram、英数字は単語単位）で行います。グラフも Neptune を使わず DynamoDB で持ちます。どちらもコストを抑えるための選択です。

### 外部依存

実行時に使う外部ライブラリは `marked`（Markdown の描画）と `DOMPurify`（XSS 対策）の 2 つだけです。YAML (frontmatter) パーサ、JWT 検証、ZIP 入出力、MCP サーバ、CLI は Node 標準機能で自作しています。`npm run lint` で、許可した依存以外が入っていないことを検査します。

## 権限モデル

記事ごとに「閲覧範囲」と「編集範囲」を設定します。判定は `src/shared/permissions.ts` の 1 か所で行い、API、MCP、画面のすべてがこれを使います。

| 設定 | 値 |
|---|---|
| 閲覧 `readScope` | `admin` 管理者のみ / `owner` オーナー（作成者）のみ / `all` だれでも（ログインユーザ） |
| 編集 `writeScope` | `none` 読み取りのみ / `admin` 管理者のみ / `owner` オーナーのみ / `all` 投稿者全員 |

- 管理者は常に閲覧・編集できます。閲覧者 (viewer) はどの記事も編集できません。新規作成は投稿者 (editor) 以上ができます。編集範囲を閲覧範囲より広くすることはできません。
- 閲覧できない記事は、一覧・検索・タグ・グラフ・バックリンク・履歴のどこにも現れず、直接アクセスしても 404 になります。検索のスコアや一覧のカーソルからも存在が推測できないようにしています。
- 過去の版は、その版を書いたときの閲覧範囲でも判定します（範囲を広げても、以前の秘密の版は見えません）。
- **削除は Web 画面からのみ**行えます（論理削除で、管理者は復元できます）。MCP と CLI には削除機能がなく、サーバー側でも Web 用クライアントのトークン以外からの削除を拒否します。
- **権限を広げられるのは Web 画面からだけです。** CLI / MCP / API のトークンでは狭めることしかできません。シェルを使えるエージェントがプロンプトインジェクションを受けても、記事を公開されないようにするためです。
- 編集は**楽観ロック**です（`version` が一致しなければ 409）。

## セットアップ

前提: Node.js 20 以上（CI は 24）、AWS CLI、管理者権限の資格情報、既定の CDK bootstrap（us-west-2 と us-east-1）。

```bash
npm ci
npm test                 # 単体テストと結合テスト（API / MCP / CLI を E2E で確認）
npm run lint             # セキュリティポリシーの静的チェック
```

### 1. 共有アカウントの境界（初回のみ・管理者が実施）

dev と prod は同じ AWS アカウントに置いています。dev のパイプラインが侵害されても prod や他のリソースに届かないよう、dev には専用の CDK bootstrap と permissions boundary を使います。詳しくは [docs/security.md](docs/security.md#dev--prod-の分離共有アカウント) を参照してください。

```bash
npm run build
npx cdk deploy MCPWiki-guard          # 権限境界 MCPWikiDevBoundary
node scripts/bootstrap-dev.mjs        # dev 専用 bootstrap (qualifier mwdev)。全ロールに境界を付ける
```

![CI/CD and isolation](docs/images/cicd-security.png)

### 2. 独自ドメイン（任意）

`config/domains.example.json` をコピーして `config/domains.local.json`（Git 管理外）を作ります。

```json
{ "zoneName": "example.com", "hostedZoneId": "Z0123456789EXAMPLE", "hosts": { "dev": "wiki-dev.example.com", "prod": "wiki.example.com" } }
```

- us-east-1 の `MCPWiki-<env>-edge` が ACM 証明書（`<host>`、`auth.<host>`）と CAA レコードを作ります。DNS 検証のレコードを残し続けるので、ACM が**自動で更新**します。残り 30 日を切るとアラームが鳴ります。
- CloudFront は `<host>` で配信し（`TLSv1.2_2021`）、ログイン画面は `auth.<host>` になります。`*.cloudfront.net` は `<host>` へ 308 でリダイレクトします。
- 設定が無ければ `*.cloudfront.net` のまま動作します。

### 3. デプロイ

```bash
npm run deploy:dev       # MCPWiki-dev-edge + MCPWiki-dev
npm run deploy:prod      # MCPWiki-prod-edge (証明書 + WAF) + MCPWiki-prod
scripts/create-admin.sh dev <username> <email> admin   # 最初の管理者を招待
```

招待メールの仮パスワードでサインインし、パスワード変更と TOTP 登録を行います。以降のユーザは管理画面（`/admin`）から招待できます。
アラームの通知先は `MCPWIKI_ALARM_EMAIL=ops@example.com`（または `-c alarmEmail=...`）で指定します。prod で未設定のときは synth 時に警告が出ます。

## CI/CD とセキュリティレビュー

| ワークフロー | 契機 | 内容 |
|---|---|---|
| `ci.yml` | PR / main | lint（依存、XSS、ワークフローの固定）、型検査、テスト（セキュリティ回帰テストを含む）、`cdk synth` + **cdk-nag**、`npm audit`、`npm audit signatures` |
| `security.yml` | PR / main / 毎週 | **gitleaks**（全履歴の秘密情報）、**Dependency Review**（PR）、**checkov**（合成済みテンプレート）、**zizmor**（Actions の監査）、**OWASP ZAP** baseline（dev、毎週）、**Claude による AI レビュー**（任意） |
| `codeql.yml` | PR / main / 毎週 | **CodeQL**（security-extended、TypeScript と GitHub Actions） |
| `scorecard.yml` | main / 毎週 | **OpenSSF Scorecard** |
| `deploy.yml` | main → dev、`v*` タグ → prod | 認証情報を持たないジョブで build/synth し、デプロイするジョブだけが OIDC トークンを得ます（`npm ci --ignore-scripts`、キャッシュなし） |

結果は GitHub の Security タブ（Code scanning）に集約されます。アクションはすべてコミット SHA で固定し、Dependabot が更新します。

### GitHub 側の初期設定（初回のみ）

1. デプロイロールを作ります: `npx cdk deploy MCPWiki-ci -c githubRepo=<owner>/<repo>`
2. OIDC の `sub` に ref を含めます（ロールの信頼条件は `environment` と `ref` の両方を要求します）。
   ```bash
   gh api -X PUT repos/<owner>/<repo>/actions/oidc/customization/sub \
     --input - <<< '{"use_default":false,"include_claim_keys":["repo","context","ref"]}'
   ```
3. Environments の `dev` と `prod` に変数を設定します: `AWS_DEPLOY_ROLE_ARN`（スタック出力）、`AWS_ACCOUNT_ID`、`AWS_REGION`、`MCPWIKI_DOMAINS`（任意）、`MCPWIKI_ALARM_EMAIL`。
4. `prod` には **Required reviewers** と「自分の承認を禁止」を設定し、デプロイ元を `v*` タグに限定します。`dev` は `main` に限定します。
5. ブランチ保護（PR 必須、CI / Security / CodeQL の成功を必須）、`v*` のタグ保護、Secret scanning と push protection、Private vulnerability reporting を有効にします。
6. 任意: リポジトリ変数 `DEV_URL`（ZAP の対象）と、`ENABLE_AI_SECURITY_REVIEW=true` + シークレット `ANTHROPIC_API_KEY`（AI レビュー）を設定します。

## CLI

```bash
npm run build
install -m 755 dist/cli/mcpwiki.mjs ~/.local/bin/mcpwiki     # 依存なしの単一ファイル

mcpwiki configure --env dev --url https://wiki-dev.example.com
mcpwiki login                     # ブラウザで MFA 付きサインイン (PKCE)
mcpwiki list --tag aws
mcpwiki search 東京タワー
mcpwiki get <id>                  # OKF 文書（frontmatter + Markdown）を出力
mcpwiki create --title "手順書" --tags ops,aws --file doc.md
mcpwiki edit <id>                 # $EDITOR で OKF 文書を編集（楽観ロック付き）
mcpwiki graph <id> --depth 2 --tags
mcpwiki export --out bundle.zip   # 自分が読める記事の OKF バンドル
```

ブラウザが別のマシンにある場合は、サインイン後に表示される `http://localhost:53682/callback?...` の URL を CLI に貼り付けてください。トークンは `~/.config/mcpwiki/credentials.json`（0600）に保存し、自動で更新します。

## MCP

```bash
mcpwiki login --env dev
claude mcp add mcpwiki -- mcpwiki mcp --env dev      # stdio ブリッジ（推奨）
```

リモートのエンドポイントは `https://<host>/mcp`（Streamable HTTP）です。未認証のリクエストには、RFC 9728 の `WWW-Authenticate: Bearer resource_metadata=...` を付けて 401 を返します。認可サーバは Cognito（PKCE、事前登録クライアント `cliClientId`、コールバック `http://localhost:53682/callback`）です。

| ツール | 内容 |
|---|---|
| `list_articles` / `get_article` / `search_articles` | 一覧、OKF 文書の取得（過去の版も可）、全文検索 |
| `create_article` / `update_article` | 作成（既定は `status: draft`）、部分更新（`version` 必須、権限は狭めるだけ） |
| `list_tags` / `get_graph` / `get_backlinks` | タグ、関連グラフ（`link` は有向、`tag` は共通タグ）、被リンク |

記事の内容は信頼できないデータとして扱い、応答ごとにランダムな境界タグで区切って返します。

## OKF について

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

- 記事間のリンクは `[表示名](/wiki/<id>)` と書きます（`/wiki/<id>.md` や `<id>.md` も認識します）。
- `generated.by` には、Web と CLI の編集なら `human:<ユーザ名>`、MCP の編集なら `mcpwiki-mcp/<version>` が入ります。「レビュー済みにする」を押すと `verified` に追加されます（内容が変わるとリセット）。
- 拡張キーは保持されます。エクスポートされるバンドルは `index.md`（`okf_version: "0.2"`）と `wiki/<id>.md` で構成されます。

## コスト目安

小規模（数十ユーザ、数千記事）なら、dev は月数ドルです。prod は WAF（月 9 ドル前後）、WAF のログ、Backup（データ量に比例）を加えて、月 10〜20 ドル程度の見込みです。常時起動のリソースはありません。

## ディレクトリ

```
src/shared   権限、OKF、YAML サブセット、トークン化、入力検証（API / Web / CLI で共通）
src/backend  Lambda: ルーティング、JWT 検証、業務ロジック、MCP、DynamoDB/S3 ストア、ZIP
src/web      SPA（ユーザ画面と管理画面）
src/cli      mcpwiki CLI と MCP stdio ブリッジ
src/infra    CDK: WikiStack / EdgeStack / GuardStack / CiStack
test         node:test（E2E とセキュリティ回帰テストを含む）
scripts      build / lint / smoke / create-admin / bootstrap-dev / diagrams
docs         設計資料と図
```

セキュリティ設計の詳細: [docs/security.md](docs/security.md) / 脆弱性の報告: [SECURITY.md](SECURITY.md)

## ライセンス

MIT
