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

## 画面とヘルプページ

- 画面の左に常にサイドバーがあります（ナビゲーション、ヘルプ、最近の更新、タグ）。幅の狭い画面では ☰ で開閉します。
- 初回起動時に、ヘルプ記事 `help-wiki`（MCPWiki の使い方）と `help-markdown`（Markdown の書き方）を自動で作成します。全員が閲覧でき、編集できるのは管理者だけです。だれも編集していない間は、原稿の更新がデプロイ後に反映されます。管理者が編集または削除した記事は、そのまま残します（再作成も上書きもしません）。原稿は `src/backend/seed/*.md` で、変更後は `node scripts/gen-seed.mjs` を実行します（lint が生成物の更新漏れを検査します）。
- 画面の下のフッターに、MCPWiki のバージョン（リリースではタグ名、それ以外は `git describe` の結果）と GitHub へのリンクを表示します。

## 管理者の機能

- **サイトタイトル**: 「管理 → サイト設定」で変更できます（60 文字まで）。ヘッダー、ブラウザのタブ、エクスポートの `index.md` に使われます。サインイン前の画面は「MCPWiki」のままです。
- **全記事の一括ダウンロード**: 「管理 → OKF 入出力」の「全記事を ZIP でダウンロード」で、公開中のすべての記事（閲覧範囲を問わず、削除済みは除く）を OKF バンドル（`index.md` と、frontmatter 付きの `wiki/<id>.md`）としてダウンロードします。そのままインポートできます。添付ファイルは含みません。ZIP は S3 の `exports/` に作られ、有効期限 5 分の署名付き URL で渡されます。ファイルは 1 日後に自動で削除されます。Web 画面の管理者だけが使えます（CLI / MCP からは使えません）。監査ログに `export-all` として記録されます。

## 添付ファイル（画像・PDF）

- 対応形式は PNG、JPEG、GIF、WebP、PDF で、1 ファイル 10MB まで、1 記事 100 ファイルまでです。SVG と HTML はスクリプトを含められるため受け付けません。
- 編集画面の「画像・PDF を添付」ボタン、ドラッグ＆ドロップ、貼り付けで添付すると、`![名前](/wiki/<記事ID>/files/<ファイルID>)` がカーソル位置に挿入されます。PDF はリンク形式になります。
- **アクセス権は記事に従います。** 閲覧するには記事の閲覧権限が、添付と削除には編集権限が必要です。非公開の記事の添付は、URL を知っていても見られません。
- ファイルは Lambda を経由せず、有効期限 5 分の署名付き URL で S3 と直接やり取りします。署名の際に、保存先の場所、形式、サイズを固定します。アップロード後には、サーバーがファイル先頭のバイト列で形式を確認し、一致しなければ破棄します。画像はページ内に表示し、PDF は常にダウンロードとして扱います。
- 削除は Web 画面からのみ行えます。S3 のバージョン管理により、管理者は復元できます。
- CLI: `mcpwiki attach <id> <ファイル>`、`mcpwiki attachments <id>`、`mcpwiki download <id> <ファイルID>`。MCP: `list_attachments`、`get_attachment`（3MB までの画像を LLM に渡します）。MCP からはアップロードできません。

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
| `security.yml` | PR / main / 毎週 | **gitleaks**（全履歴の秘密情報）、**OSV-Scanner**（既知の脆弱性と悪性パッケージ）、**Dependency Review**（PR）、**checkov**（合成済みテンプレート）、**zizmor**（Actions の監査）、**OWASP ZAP** baseline（dev、毎週）、**Claude による AI レビュー**（任意） |
| `supply-chain.yml` | 依存を変更する PR | **lockfile の審査**（公開から 7 日未満・インストールスクリプトの追加・provenance の欠落・レジストリ以外からの取得を拒否。公開者の変更と新規の依存は警告。実行時の依存の差分を保存）、**インフラ差分**（変更前後で synth して比較し、依存だけの PR でセキュリティに関わるリソースが変われば停止） |
| `codeql.yml` | PR / main / 毎週 | **CodeQL**（security-extended、TypeScript と GitHub Actions） |
| `scorecard.yml` | main / 毎週 | **OpenSSF Scorecard** |
| `deploy.yml` | main → dev、`v*` タグ → prod | 認証情報を持たないジョブで build/synth し、デプロイするジョブだけが OIDC トークンを得ます（`npm ci --ignore-scripts`、キャッシュなし） |

**Private リポジトリで運用する場合:** Code scanning（SARIF のアップロード）、Dependency Review、Secret scanning は、GitHub の有償機能（GitHub Code Security / Secret Protection）が必要です。既定ではこれらを使わず、各スキャナは指摘があればジョブを失敗させ、レポートを artifact に残します（CodeQL も同じ）。Public にする、または有償機能を契約したら、リポジトリ変数 `CODE_SCANNING_ENABLED=true` を設定すると、結果が GitHub の Security タブ（Code scanning）に集約されます。Rulesets によるブランチ保護と、Environment の Required reviewers も、Private ではプランによって使えないことがあります。

アクションはすべてコミット SHA で固定し、Dependabot が更新します。

### GitHub 側の初期設定（初回のみ）

1. デプロイロールを作ります: `npx cdk deploy MCPWiki-ci -c githubRepo=<owner>/<repo>`
2. OIDC の `sub` に ref を含めます（ロールの信頼条件は `environment` と `ref` の両方を要求します）。
   ```bash
   gh api -X PUT repos/<owner>/<repo>/actions/oidc/customization/sub \
     --input - <<< '{"use_default":false,"include_claim_keys":["repo","context","ref"]}'
   gh api repos/<owner>/<repo>/actions/oidc/customization/sub    # sub_claim_prefix を確認
   ```
   GitHub は、ID を含む変更不能な `sub`（`repo:<owner>@<owner-id>/<repo>@<repo-id>`）を使います。表示された `sub_claim_prefix` を `cdk.json` の `context.githubOidcSubjectPrefix` に設定し、手順 1 の CI スタックをデプロイし直してください。名前を変更されたり、同じ名前のリポジトリを第三者に作られたりしても、ロールを引き受けられません。
3. 準備が整ったら、リポジトリ変数 `DEPLOY_ENABLED=true` を設定します（設定するまで Deploy ワークフローはスキップされます）。環境固有の値は**シークレット**として登録します。リポジトリのシークレットに `AWS_ACCOUNT_ID`、`MCPWIKI_DOMAINS`（任意）、`MCPWIKI_ALARM_EMAIL` を、Environments の `dev` と `prod` のシークレットに `AWS_DEPLOY_ROLE_ARN`（スタック出力）を登録します。`AWS_REGION` だけはリポジトリの変数で構いません。変数（vars）は、マスクが効く前にランナーが各ステップの環境変数として表示するので、公開ログに値が出てしまいます。lint で、vars から読むことを禁止しています。
4. Environments の `dev` と `prod` に、シークレット `ARTIFACT_ENCRYPTION_KEY` を登録します（環境ごとに別の値）。Deploy の artifact（合成済みのアセンブリ）を暗号化する鍵で、未設定だとデプロイは失敗します。
   ```bash
   openssl rand -hex 32 | gh secret set ARTIFACT_ENCRYPTION_KEY --env dev  -R <owner>/<repo>
   openssl rand -hex 32 | gh secret set ARTIFACT_ENCRYPTION_KEY --env prod -R <owner>/<repo>
   ```
5. `prod` には **Required reviewers** を設定し、デプロイ元を `v*` タグに限定します。`dev` は `main` に限定します。メンテナが 1 人のあいだは「Prevent self-review」を有効にしないでください（自分で承認できなくなり、prod にデプロイできなくなります）。
6. 任意: シークレット `DEV_URL`（ZAP の対象）と、`ENABLE_AI_SECURITY_REVIEW=true` + シークレット `ANTHROPIC_API_KEY`（AI レビュー）を設定します。ZAP のレポートを保存する場合は、リポジトリのシークレット `ARTIFACT_ENCRYPTION_KEY` も設定します（暗号化して保存します）。

### 公開リポジトリにする場合

Public リポジトリでは、Actions のログ、ジョブのサマリ、artifact を誰でも読めます。このため、環境固有の値（アカウント ID、ホストゾーン、ホスト名、User Pool ID など）は、ワークフローの中でマスクと伏せ字にしています（`scripts/ci/mask.sh`、`scripts/ci/redact.mjs`）。合成済みのアセンブリは暗号化しています（`scripts/ci/seal.sh`）。どちらも lint で強制しています。公開する前に、GitHub で次の設定を行ってください。

| 設定 | 場所 | 内容 |
|---|---|---|
| ブランチ保護 | Settings → Rules → Rulesets（`main`） | PR 必須（承認 0 件で可）、必須チェック（CI `test`、CodeQL の 2 ジョブ、Security の各ジョブ）、force push 禁止、削除禁止 |
| タグ保護 | Rulesets（tag、`v*`） | 作成・更新・削除を管理者だけに制限（prod へのデプロイはタグで動くため） |
| fork の PR | Settings → Actions → General | 「Require approval for all external contributors」。Workflow permissions は「Read repository contents」 |
| コードスキャン | Settings → Advanced Security | Code scanning、Secret scanning と push protection、Private vulnerability reporting を有効化。リポジトリ変数 `CODE_SCANNING_ENABLED=true` |

Issue と PR は誰でも作成できます。マージは、書き込み権限を持つ人（メンテナ）だけが行えます。貢献の手順は [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

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
mcpwiki attach <id> shot.png      # 添付（表示された Markdown を本文に貼る）
mcpwiki attachments <id>          # 添付の一覧
mcpwiki download <id> <ファイルID> # 添付の保存
```

ブラウザが別のマシンにある場合は、サインイン後に表示される `http://localhost:53682/callback?...` の URL を CLI に貼り付けてください。トークンは `~/.config/mcpwiki/credentials.json`（0600）に保存し、自動で更新します。

### Windows

CLI と MCP ブリッジは Windows でもそのまま動きます（`npm test` の E2E も Windows で通ります）。前提は [Node.js](https://nodejs.org/) 20 以上と Git です。

```cmd
git clone https://github.com/siseru/mcpwiki.git
cd mcpwiki
npm ci --ignore-scripts
npm run build
npm install -g .                  :: mcpwiki コマンド（npm が mcpwiki.cmd を作ります）
mcpwiki configure --env dev --url https://wiki-dev.example.com
mcpwiki login
```

インストールせずに `node dist\cli\mcpwiki.mjs <command>` と直接呼んでも同じです。Windows では次の点が異なります。

- 設定とトークンは `%APPDATA%\mcpwiki\`（`XDG_CONFIG_HOME` があればそちら）に保存します。POSIX の `0600` に相当する保護はなく、ユーザープロファイルの ACL に従います。
- `mcpwiki login` は `rundll32.exe url.dll,FileProtocolHandler` 経由で既定のブラウザを開きます（`--no-browser` で URL を手で開くこともできます）。
- `mcpwiki edit <id>` の既定のエディタは `notepad.exe` です。`VISUAL` / `EDITOR` を設定する場合、空白を含むパスは引用符で囲みます（例: `set EDITOR="C:\Program Files\Notepad++\notepad++.exe" -multiInst`）。`code --wait` のような `.cmd` のラッパも使えます。エディタは**閉じるまで待つもの**を指定してください。
- `--file` に渡す Markdown は CRLF でも BOM 付きでも構いません（読み込み時に正規化します）。
- `npm run build` / `npm test` / `npm run lint` / `npm run typecheck` / `npm run synth` は cmd / PowerShell でも動きます（CI も `windows-latest` で lint・typecheck・テストを実行します）。bash が必要なのはデプロイ用の `scripts/create-admin.sh` だけです（Git Bash か WSL で実行してください）。

## MCP

MCP クライアントからは、CLI に組み込まれた stdio ブリッジ（`mcpwiki mcp`）を使うのが簡単です。ブリッジは CLI に保存されたログイン情報を使い、トークンの更新も自動で行います。先に CLI でログインしてください（`mcpwiki whoami` が通る状態）。

```bash
mcpwiki configure --env dev --url https://wiki-dev.example.com
mcpwiki login --env dev
```

### Claude Code

```bash
claude mcp add --scope user mcpwiki -- mcpwiki mcp --env dev
claude mcp list            # mcpwiki が Connected になっていることを確認
```

Windows では `mcpwiki` が `mcpwiki.cmd` になり、MCP クライアントからは起動できないことがあります。`node` で `.mjs` を直接起動してください（パスは clone した場所に合わせます）。

```cmd
claude mcp add --scope user mcpwiki -- node C:\Users\<user>\mcpwiki\dist\cli\mcpwiki.mjs mcp --env dev
```

- `--scope user` を付けると、どのディレクトリで起動しても使えます（リポジトリ単位にしたい場合は `--scope project`）。
- 登録後に Claude Code を起動し直し、`/mcp` で接続状態とツールの一覧を確認します。
- 例:「MCPWiki で istus の記事を探して要約して」「今日の作業を MCPWiki に記事としてまとめて。タグは worklog」

### Kiro

`~/.kiro/settings/mcp.json`（全ワークスペース共通）か、ワークスペースの `.kiro/settings/mcp.json` の `mcpServers` に追加します。既存のサーバの設定は残してください。

```json
{
  "mcpServers": {
    "mcpwiki": {
      "command": "/usr/bin/node",
      "args": ["/home/<user>/.local/bin/mcpwiki", "mcp", "--env", "dev"],
      "disabled": false,
      "autoApprove": ["list_articles", "get_article", "search_articles", "list_tags", "get_graph", "get_backlinks", "list_attachments", "get_attachment"]
    }
  }
}
```

- Kiro の起動環境では `~/.local/bin` が PATH に入っていないことがあるので、`node` と `mcpwiki` は**絶対パス**で書きます（`which node` と `which mcpwiki` で確認できます）。
- Windows では、`args` に `mcpwiki.cmd`（`where mcpwiki` が返すパス）ではなく、clone した場所の `dist\cli\mcpwiki.mjs` を書きます。`node.exe` のパスは `where node` で確認します。JSON ではバックスラッシュを `\\` と書きます。

  ```json
  "command": "C:\\Program Files\\nodejs\\node.exe",
  "args": ["C:\\Users\\<user>\\mcpwiki\\dist\\cli\\mcpwiki.mjs", "mcp", "--env", "dev"],
  ```
- `autoApprove` には読み取り用のツールだけを入れます。作成（`create_article`）と更新（`update_article`）は、実行前に Kiro が確認を求めます。
- 保存したら、Kiro パネルの MCP SERVERS で `mcpwiki` が接続済みになり、10 個のツールが表示されることを確認します（表示されなければ再接続します）。

### 共通の注意

- MCP から作成した記事は `draft` として保存されます。内容を確認したら、Web 画面の「レビュー済みにする」で人による確認を記録してください。
- MCP からは削除できず、閲覧・編集範囲を広げることもできません（Web 画面でのみ可能）。
- `session expired` になったら `mcpwiki login` を実行し直します（リフレッシュトークンの有効期限は 7 日）。

リモートのエンドポイントは `https://<host>/mcp`（Streamable HTTP）です。未認証のリクエストには、RFC 9728 の `WWW-Authenticate: Bearer resource_metadata=...` を付けて 401 を返します。認可サーバは Cognito（PKCE、事前登録クライアント `cliClientId`、コールバック `http://localhost:53682/callback`）です。

| ツール | 内容 |
|---|---|
| `list_articles` / `get_article` / `search_articles` | 一覧、OKF 文書の取得（過去の版も可）、全文検索 |
| `create_article` / `update_article` | 作成（既定は `status: draft`）、部分更新（`version` 必須、権限は狭めるだけ） |
| `list_tags` / `get_graph` / `get_backlinks` | タグ、関連グラフ（`link` は有向、`tag` は共通タグ）、被リンク |
| `list_attachments` / `get_attachment` | 添付の一覧、画像の取得（3MB まで。PDF はメタデータのみ） |

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

すべてのリソースに、コスト配分タグ `Project=mcpwiki`、`Environment=dev|prod`（共通のスタックは `shared`）、`Component=app|edge|cicd|guard`、`ManagedBy=cdk` を付けます。Cost Explorer では、Billing の「コスト配分タグ」で有効にしたキーで集計できます（有効化は管理アカウントで一度だけ。タグが付いてから一覧に出るまで最大 24 時間かかります）。タグは `-c costTags='{"CostCenter":"…"}'` で追加・上書きできます。

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

Apache License 2.0（[LICENSE](LICENSE)）
