# デプロイ手順

[English](deploy.en.md) | 日本語

MCPWiki を自分の AWS アカウントに構築し、GitHub Actions から dev / prod へ自動でデプロイできるようにするまでの手順です。初回は 1〜2 時間を見込んでください（DNS と証明書の待ち時間を含みます）。

- [全体の流れ](#全体の流れ)
- [0. 前提](#0-前提)
- [1. リポジトリを用意する](#1-リポジトリを用意する)
- [2. AWS アカウントの準備（初回のみ・管理者）](#2-aws-アカウントの準備初回のみ管理者)
- [3. 独自ドメイン（任意）](#3-独自ドメイン任意)
- [4. 手元から dev をデプロイする](#4-手元から-dev-をデプロイする)
- [5. 最初の管理者を作る](#5-最初の管理者を作る)
- [6. GitHub Actions からデプロイする](#6-github-actions-からデプロイする)
- [7. prod をリリースする](#7-prod-をリリースする)
- [8. GitHub リポジトリの保護設定](#8-github-リポジトリの保護設定)
- [9. 運用](#9-運用)
- [10. トラブルシューティング](#10-トラブルシューティング)
- [11. 撤去](#11-撤去)

## 全体の流れ

| 段階 | 誰が | どこから | 内容 |
|---|---|---|---|
| 1〜3 | 管理者 | 手元 | fork、AWS の土台（権限境界、bootstrap）、ドメインの設定 |
| 4〜5 | 管理者 | 手元 | dev の初回デプロイと、最初の管理者ユーザの招待 |
| 6 | 管理者 | 手元 + GitHub | CI 用ロール、OIDC、シークレット、Environments |
| 7 以降 | メンテナ | GitHub | `main` へのマージで dev、`v*` タグの push（承認 2 回）で prod |

dev と prod は**同じ AWS アカウント**に置く前提です。dev のパイプラインが侵害されても prod や同じアカウントの他のリソースに届かないよう、権限境界と dev 専用の CDK bootstrap を使います（[docs/security.md](security.md#dev--prod-の分離共有アカウント)）。dev 用に別のアカウントを使う場合も、手順はそのままで構いません（境界は追加の制限として働くだけです）。

## 0. 前提

| もの | 用途 |
|---|---|
| AWS アカウントと、管理者権限の資格情報 | 手順 2〜6（その後は CI が OIDC でデプロイします） |
| [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) | `aws sts get-caller-identity` が通ること |
| Node.js 20 以上（CI は 24）と npm | ビルド、テスト、CDK |
| Git、[GitHub CLI](https://cli.github.com/)（`gh`） | fork と、GitHub の設定（手順 6） |
| Route 53 のパブリックホストゾーン（任意） | 独自ドメインを使う場合（手順 3） |
| `openssl` | 暗号鍵の生成（手順 6） |

リージョンは `cdk.json` の `context.region`（既定は `us-west-2`）です。変える場合は最初に書き換えてください。CloudFront 用の証明書と WAF は、常に `us-east-1` に作ります。

> **注意:** シェルに `AWS_REGION` / `AWS_DEFAULT_REGION` が設定されていても、MCPWiki のスクリプトは `cdk.json` のリージョンを使います。`aws` コマンドを直接打つときは `--region` を付けてください。

## 1. リポジトリを用意する

fork（または自分のリポジトリへの複製）をして clone します。

```bash
gh repo fork siseru/mcpwiki --clone
cd mcpwiki
npm ci --ignore-scripts
npm test          # 単体テストと E2E（API / MCP / CLI）
npm run lint      # セキュリティポリシーの静的チェック
```

fork では、次の値を自分のものに書き換えます。

| ファイル | 値 | 書き換えないと |
|---|---|---|
| `package.json` | `repository.url` | 画面のフッターの GitHub リンクが元のリポジトリを指します |
| `cdk.json` | `context.githubOidcSubjectPrefix` | CI 用ロールを作れません（手順 6 で設定します。元の値のままだと synth が止まります） |
| `.github/CODEOWNERS` | `@siseru` | レビュー依頼が元のメンテナに飛びます |
| `.github/ISSUE_TEMPLATE/config.yml` | 脆弱性報告の URL | 報告が元のリポジトリに届きます |

`githubOidcSubjectPrefix` は、CI のロールを**リポジトリの数値 ID で**固定する値です。元のリポジトリの値のまま CI 用ロールを作ると、あなたの AWS アカウントのロールが元のリポジトリのワークフローを信頼してしまいます。これを防ぐため、`githubRepo` と名前が一致しなければ synth は失敗します。手順 6 までは空（`""`）にしておいて構いません。

## 2. AWS アカウントの準備（初回のみ・管理者）

管理者の資格情報で実行します。

```bash
npm run build
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION=$(node -p "require('./cdk.json').context.region")

# prod 用（既定の qualifier）の CDK bootstrap。証明書と WAF のために us-east-1 にも必要です
npx cdk bootstrap "aws://$ACCOUNT/$REGION" "aws://$ACCOUNT/us-east-1"

# 共有アカウントの境界（権限境界 MCPWikiDevBoundary）
npx cdk deploy MCPWiki-guard

# dev 専用の bootstrap（qualifier mwdev）。すべての bootstrap ロールに境界を付けます
node scripts/bootstrap-dev.mjs
```

- `MCPWiki-guard` と `bootstrap-dev.mjs` は CI からは実行しません。境界を変えるのは管理者だけです。
- 独自ドメインを使う場合は、guard をデプロイする**前に**手順 3 の設定ファイルを作ってください（境界が dev のホスト名だけに Route 53 の変更を許すためです）。後から作った場合は、guard をデプロイし直します。

## 3. 独自ドメイン（任意）

`config/domains.example.json` をコピーして `config/domains.local.json` を作ります。このファイルは Git の管理外です（ホストゾーンの情報をリポジトリに入れないため）。

```json
{ "zoneName": "example.com", "hostedZoneId": "Z0123456789EXAMPLE", "hosts": { "dev": "wiki-dev.example.com", "prod": "wiki.example.com" } }
```

- `us-east-1` の `MCPWiki-<env>-edge` スタックが、ACM 証明書（`<host>` と `auth.<host>`）と CAA レコードを作ります。DNS 検証のレコードを残すので、証明書は**自動で更新**されます。残り 30 日を切るとアラームが鳴ります。
- ログイン画面は `auth.<host>`（Cognito のカスタムドメイン）になります。`*.cloudfront.net` へのアクセスは `<host>` に 308 でリダイレクトします。
- 設定がなければ `*.cloudfront.net` のドメインで動きます。
- CI では、このファイルの中身を 1 行の JSON にしてシークレット `MCPWIKI_DOMAINS` に入れます（手順 6）。

## 4. 手元から dev をデプロイする

```bash
npm run deploy:dev     # MCPWiki-dev-edge と MCPWiki-dev（初回は 15〜30 分）
```

- IAM の変更の確認を求められたら、内容を確かめて `y` を入力します。
- 終わると `MCPWiki-dev.Url` が表示されます。確認には次を使います（認証なしで確認できる範囲: ヘッダ、401、リダイレクト）。

  ```bash
  node scripts/smoke.mjs https://wiki-dev.example.com
  ```

- 初回の起動時に、ヘルプ記事（`help-wiki` と `help-markdown`）が自動で作られます。

## 5. 最初の管理者を作る

```bash
scripts/create-admin.sh dev <ユーザ名> <メールアドレス> admin
```

1. 仮パスワードがメールで届きます。サイトを開いてサインインし、パスワードを変えます（12 文字以上、4 種類の文字）。
2. 認証アプリ（Google Authenticator、1Password など）で QR コードを読み取り、TOTP を登録します。MFA は必須です。
3. 以降のユーザは、Web 画面の「管理 → ユーザ」から招待できます。

## 6. GitHub Actions からデプロイする

### 6.1 CI 用ロール

```bash
REPO=<owner>/<repo>

# OIDC の sub に ref を含める（ロールは environment と ref の両方を要求します）
gh api -X PUT repos/$REPO/actions/oidc/customization/sub \
  --input - <<< '{"use_default":false,"include_claim_keys":["repo","context","ref"]}'
gh api repos/$REPO/actions/oidc/customization/sub --jq .sub_claim_prefix
```

表示された値（`repo:<owner>@<owner-id>/<repo>@<repo-id>` の形）を `cdk.json` の `context.githubOidcSubjectPrefix` に書いてコミットし、CI 用ロールを作ります。

```bash
npm run build
npx cdk deploy MCPWiki-ci -c githubRepo=$REPO
```

出力の `DeployRoleArndev` と `DeployRoleArnprod` を控えます。dev のロールは `environment:dev` かつ `ref:refs/heads/main`、prod のロールは `environment:prod` かつ `ref:refs/tags/v*` のときだけ引き受けられます。数値 ID で固定しているので、リポジトリ名を変えられたり、同じ名前のリポジトリを他人に作られたりしても引き受けられません。

### 6.2 Environments

GitHub の Settings → Environments で `dev` と `prod` を作ります。

| Environment | Deployment branches and tags | Required reviewers |
|---|---|---|
| `dev` | `main` だけ | なし |
| `prod` | タグ `v*` だけ | 自分（メンテナ）。メンテナが 1 人のあいだは「Prevent self-review」を**有効にしない**でください（自分で承認できなくなります） |

### 6.3 シークレットと変数

**環境固有の値はすべて「シークレット」に入れます。** 変数（vars）は、ランナーが各ステップの環境変数として**マスクの前に**ログへ表示するため、公開リポジトリではアカウント ID やドメインがそのまま読めてしまいます（lint で vars からの読み取りを禁止しています）。

```bash
# リポジトリのシークレット
gh secret set AWS_ACCOUNT_ID -R $REPO --body "$ACCOUNT"
gh secret set MCPWIKI_DOMAINS -R $REPO < <(node -e 'process.stdout.write(JSON.stringify(require("./config/domains.local.json")))')   # 任意
gh secret set MCPWIKI_ALARM_EMAIL -R $REPO --body ops@example.com                                                                  # 任意（prod で未設定だと synth が警告）

# Environment のシークレット
gh secret set AWS_DEPLOY_ROLE_ARN --env dev  -R $REPO --body <DeployRoleArndev>
gh secret set AWS_DEPLOY_ROLE_ARN --env prod -R $REPO --body <DeployRoleArnprod>
openssl rand -hex 32 | gh secret set ARTIFACT_ENCRYPTION_KEY --env dev  -R $REPO   # 合成済みアセンブリの暗号鍵（環境ごとに別の値）
openssl rand -hex 32 | gh secret set ARTIFACT_ENCRYPTION_KEY --env prod -R $REPO

# リポジトリの変数（秘密でない値だけ）
gh variable set AWS_REGION -R $REPO --body "$REGION"
gh variable set DEPLOY_ENABLED -R $REPO --body true    # これを設定するまで Deploy ワークフローはスキップされます
```

任意の設定:

| 名前 | 種類 | 用途 |
|---|---|---|
| `DEV_URL` | シークレット | 毎週の OWASP ZAP baseline の対象（dev の URL） |
| `ARTIFACT_ENCRYPTION_KEY` | リポジトリのシークレット | ZAP のレポートを暗号化して保存する場合 |
| `ENABLE_AI_SECURITY_REVIEW=true` と `ANTHROPIC_API_KEY` | 変数とシークレット | PR ごとの AI セキュリティレビュー |
| `CODE_SCANNING_ENABLED=true` | 変数 | 結果を Security タブ（Code scanning）に集約する（Public リポジトリか、有償の GitHub Code Security が必要） |

### 6.4 動作確認

`main` に何かをマージすると（README の修正などで構いません）、Deploy ワークフローが dev にデプロイします。

- `build` ジョブ: 認証情報なしでテスト、synth、暗号化
- `deploy` ジョブ: OIDC でロールを引き受け、合成済みのアセンブリをデプロイして、スモークテストを実行

公開リポジトリでは、最初のデプロイの後に**ログ全体**を開き、アカウント ID、ホスト名、ホストゾーン ID、User Pool ID が出ていないことを確認してください。

## 7. prod をリリースする

```bash
git switch main && git pull --ff-only
git tag v0.1.0 && git push origin v0.1.0
```

1. Deploy ワークフローが `prod` の承認を待ちます（1 回目）。承認すると `build` が動き、**前回のタグとのインフラ差分**をジョブのサマリに出します。
2. 差分を読んでから、`deploy` の承認（2 回目）をします。依存の更新だけのはずなのに IAM、CloudFront、Cognito、WAF などが変わっていたら、承認しないでください。
3. 初回は、手順 5 と同じように prod の管理者を作ります（`scripts/create-admin.sh prod ...`）。

prod には、WAF、AWS Backup（毎日、35 日保持、ボールトロック）、DynamoDB の PITR、削除保護、スタックの削除保護が付きます。

## 8. GitHub リポジトリの保護設定

| 設定 | 場所 | 内容 |
|---|---|---|
| ブランチ保護 | Settings → Rules → Rulesets（`main`） | PR 必須（承認 0 件で可）、必須チェック（CI の `test`、CodeQL の 2 ジョブ、Security の各ジョブ）、force push と削除の禁止 |
| タグ保護 | Rulesets（tag、`v*`） | 作成・更新・削除を管理者だけに制限（prod へのデプロイはタグで動くため） |
| fork からの PR | Settings → Actions → General | 「Require approval for all external contributors」。Workflow permissions は「Read repository contents」 |
| コードスキャン | Settings → Advanced Security | Code scanning、Secret scanning と push protection、Private vulnerability reporting |

Private リポジトリでは、Code scanning、Dependency Review、Secret scanning、Rulesets、Environment の Required reviewers がプランによって使えません。その場合も各スキャナはジョブを失敗させ、レポートを artifact に残します。

## 9. 運用

| 作業 | 方法 |
|---|---|
| ユーザの追加・ロール変更・無効化 | Web 画面の「管理 → ユーザ」 |
| dev への反映 | `main` へのマージ（自動） |
| prod への反映 | `v*` タグの push と、承認 2 回（手順 7） |
| 依存の更新 | Dependabot の PR（公開から 7 日の待機、lockfile の審査、インフラ差分の確認つき）。[docs/security.md](security.md#依存ライブラリの侵害サプライチェーンへの対策) |
| アラームの通知先 | シークレット `MCPWIKI_ALARM_EMAIL`（手元では `MCPWIKI_ALARM_EMAIL=... npm run deploy:prod`）。SNS の確認メールのリンクを押すまで届きません |
| オリジン用シークレットのローテーション | スタック `MCPWiki-<env>` の `OriginSecret`（Secrets Manager）の値を更新して、再デプロイします。切り替えの間、短時間 403 が出ます |
| コスト | 小規模なら dev は月数ドル、prod は WAF を含めて月 10〜20 ドル程度。すべてのリソースに `Project` / `Environment` / `Component` / `ManagedBy` タグを付けているので、Billing の「コスト配分タグ」で有効にすれば Cost Explorer で集計できます |
| CI に含まれないスタック | `MCPWiki-guard` と `MCPWiki-ci` は、変更したら管理者が手元からデプロイします |

## 10. トラブルシューティング

| 症状 | 原因と対処 |
|---|---|
| `dist/ is missing: run "npm run build"` | `npx cdk ...` の前に `npm run build` を実行します（`npm run deploy:*` は自動で実行します） |
| `githubOidcSubjectPrefix (...) belongs to <owner>/<repo>, not ...` | fork で元のリポジトリの値が残っています。手順 6.1 で自分の値を設定します（それまでは `""`） |
| CI の `Configure AWS credentials` が `Not authorized to perform sts:AssumeRoleWithWebIdentity` | OIDC の `sub` がロールの条件と一致していません。手順 6.1 の customization を実行したか、`githubOidcSubjectPrefix` が `gh api .../oidc/customization/sub` の値と同じか、Environment とブランチ／タグの組み合わせ（dev は `main`、prod は `v*`）が正しいかを確認します |
| dev のデプロイで `... is not authorized to perform: iam:PassRole` | dev のロールが境界の外のロールを渡そうとしています。`MCPWiki-guard` が最新か（`npx cdk deploy MCPWiki-guard`）を確認します |
| dev のデプロイで `BootstrapVersion` や `SSM parameter /cdk-bootstrap/mwdev/version not found` | `node scripts/bootstrap-dev.mjs` を実行していないか、古いままです。bootstrap をやり直した直後の 1 回は `npx cdk deploy ... --no-previous-parameters` を付けます |
| Deploy が `seal: ARTIFACT_ENCRYPTION_KEY must be set (>= 32 chars)` で失敗 | Environment（`dev` / `prod`）にシークレット `ARTIFACT_ENCRYPTION_KEY` を登録します |
| Deploy ワークフローが常にスキップされる | リポジトリの変数 `DEPLOY_ENABLED=true` が未設定です |
| 公開ログにアカウント ID やドメインが出た | その値を vars に入れていないか確認し、シークレットに移します。該当の実行は Actions の画面（または `gh api -X DELETE repos/<owner>/<repo>/actions/runs/<id>`）で削除します |
| アラームのメールが届かない | SNS の確認メール（`AWS Notification - Subscription Confirmation`）のリンクを押していません |

## 11. 撤去

**dev**（データも削除されます）:

```bash
npx cdk destroy MCPWiki-dev MCPWiki-dev-edge
```

**prod** はデータを守るため、削除しにくくしてあります。

1. スタックの削除保護を外します: `aws cloudformation update-termination-protection --no-enable-termination-protection --stack-name MCPWiki-prod --region <region>`
2. `npx cdk destroy MCPWiki-prod MCPWiki-prod-edge` を実行します。DynamoDB のテーブル、User Pool、S3 バケット、Backup のボールトは `RETAIN` のため**残ります**。
3. 残ったリソースは、必要なデータを退避してから手動で削除します（DynamoDB と User Pool は先に削除保護を外します）。Backup のボールトはロック（最小保持 7 日）が掛かっているので、復旧ポイントを削除できるようになってから、復旧ポイント、ボールトの順に削除します。

最後に、CI 用ロールと境界を削除します: `npx cdk destroy MCPWiki-ci -c githubRepo=<owner>/<repo>`、`npx cdk destroy MCPWiki-guard`。CDK の bootstrap スタック（`CDKToolkit`、`CDKToolkit-mcpwiki-dev`）は、他に使っていなければ CloudFormation から削除します。
