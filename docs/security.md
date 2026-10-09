# セキュリティ設計と脅威モデル

[English](security.en.md) | 日本語

## 守る対象

- 記事の機密性（`readScope`）と完全性（`writeScope`、履歴）
- アカウント（MFA、トークン）
- 運用基盤（AWS リソース、デプロイ経路、同じアカウント内の他の資産）

## 認証

- Cognito User Pool で MFA を必須にしています（TOTP のみ）。招待制で、パスワードは 12 文字以上かつ 4 種類の文字をすべて含む必要があります。メールアドレスを変更しても、確認が済むまでは元のアドレスのまま保持します（`keepOriginal`）。ユーザ自身による属性の書き換えはできません。
- Managed login と PKCE を使います（Web と CLI はどちらも public client）。許可している認証フローは `ALLOW_REFRESH_TOKEN_AUTH` だけで、SRP やパスワード API は使えません。アクセストークンの有効期限は 1 時間、リフレッシュトークンは Web で 12 時間、CLI で 7 日です。
- アクセストークンは Lambda の中で検証します（`src/backend/auth.ts`）。検証するのは RS256 署名（JWKS）、`iss`、`token_use=access`、`exp` / `iat`、`client_id` の許可リストです。
- ロール変更や無効化の際は、Cognito を操作する前と後の両方で `minIat = now + 1` を記録します。それより前に発行されたトークンは即座に拒否されます。
- Web のトークンは `sessionStorage` に置きます（`localStorage` の使用は lint で禁止）。

## 認可

- 判定は `src/shared/permissions.ts` の 1 か所で行います。テストでは全組み合わせを検証しています。
- 閲覧できない記事は 404 を返します。検索は、閲覧できる候補だけに絞ってから順位を付けます（スコアから存在を推測されないため）。一覧のカーソルは AES-GCM で暗号化しています。ID が衝突したときの応答は汎用のメッセージにし、S3 にも書き込みません。
- 過去の版は、その版を書いたときの `readScope` でも判定します。
- 削除、復元、ユーザ管理、インポート、再インデックスは Web 用クライアントのトークンに限っています。レビュー済みにする操作には編集権限が必要です。
- **権限の拡大は Web からだけ可能です**（CLI / MCP / API は縮小のみ）。
- **全記事の一括ダウンロード**は Web 画面の管理者だけが使えます。ZIP は推測できない名前で S3 の `exports/` に置き、有効期限 5 分の署名付き URL で渡し、ライフサイクルルールで 1 日後に削除します。Lambda に与える権限は `exports/*` の Put と Get だけです。実行は監査ログに記録します。
- 入力は `src/shared/validate.ts` で検証します。サイズ上限、制御文字・C1 制御文字・bidi 制御文字の禁止、拡張キーの予約語と `__proto__` 等（ネストの深さを問わず）の禁止、そして保存前の往復検証（シリアライズした結果を必ず読み戻せること）を行います。

## 添付ファイル

| 脅威 | 対策 |
|---|---|
| 権限のない閲覧 | 添付は記事の `readScope` に従います。閲覧できない記事の添付は 404 を返します。Cookie を使わないため、画面はトークン付きで署名付き URL（有効期限 5 分）を取得し、`blob:` URL として表示します |
| スクリプトを含むファイル（SVG、HTML）による XSS | 形式は許可制です（PNG、JPEG、GIF、WebP、PDF）。アップロード後にマジックバイトで形式を確認し、一致しなければ破棄します。配信時は `Content-Type` を固定し、PDF は常に `attachment` として返します |
| 巨大なファイルの送り付けや、保存先の書き換え | 署名付き POST のポリシーで、保存先のキー、`Content-Type`、申告したサイズ（上限 10MB）を固定します。1 記事 100 ファイルまでで、書き込みのレート制限も適用します |
| 他人のアップロードの横取り | 完了の処理は、アップロードを始めた本人だけが行えます |
| ファイル名を使った攻撃 | 表示名から、パス、制御文字、bidi 制御文字、引用符を除去します。CLI はダウンロード時に、サーバーが返した名前をパスとして使いません |
| MCP 経由での悪用 | MCP からはアップロードできません。取得できるのは 3MB までの画像だけです |
| データの消失 | Lambda に与えている削除権限は `attachments/*` の DeleteObject だけで、バージョン削除の権限は与えていません。削除や破棄をしても、S3 のバージョンから復元できます |

## Web (XSS / クリックジャッキング)

- marked で変換したあと DOMPurify で無害化し、CSP（`script-src 'self'`、`img-src 'self' data:`、`object-src 'none'`、`frame-ancestors 'none'`、`base-uri 'none'`）を掛けます。DOM はすべて `textContent` で組み立て、`innerHTML` は lint で禁止しています。
- リンクと画像は、ブラウザが実際に解決する URL のオリジンで判定します（`/\evil.com` のような偽装を防ぐため）。外部の画像は CSP で読み込めません（閲覧者を追跡する画像の埋め込みを防ぐため）。
- HSTS、`X-Content-Type-Options`、`X-Frame-Options: DENY`、`Referrer-Policy`、`Permissions-Policy`、`COOP` を付けています。

## MCP / LLM 固有の脅威

| 脅威 | 対策 |
|---|---|
| 記事本文に仕込まれたプロンプトインジェクション | 応答ごとにランダムな境界タグで本文を区切り、本文から区切りを偽装できないようにしています。server instructions で、本文をデータとして扱うよう明示しています |
| インジェクションによる権限拡大 | Web 以外のチャネルでは権限を広げられません（MCP だけでなく CLI のトークンも同じ） |
| インジェクションによる削除 | 削除ツールがなく、サーバー側でも Web 以外からの削除を拒否します |
| LLM による上書き事故 | 楽観ロック、S3 のバージョン履歴、MCP から作成した記事は既定で `draft`、`generated.by` で出所を記録 |
| 大量の呼び出し | ユーザ単位のレート制限（MCP の書き込みも書き込みとして数える）、グラフ探索の上限、Markdown 処理の計算量を線形に抑制（ReDoS 対策）、Lambda の予約同時実行数 |
| DNS リバインディング | `/mcp` で `Origin` を検証します |

## インフラ

- S3: 全バケットでパブリックアクセスを遮断し、SSL を強制して暗号化しています。Web バケットへは OAC 経由でのみアクセスできます。Lambda には削除権限がありません。
- API Gateway を直接呼ばれないよう、CloudFront が付ける秘密ヘッダを Lambda が検証します。秘密は Secrets Manager から実行時に取得するので、Lambda の設定には現れません。
- Lambda の IAM は最小権限です。予約同時実行数（dev 20 / prod 100）を設定し、共有アカウントの同時実行枠を使い切られないようにしています。
- TLS 1.2 以上、ACM の自動更新（DNS 検証）、証明書の期限アラーム、CAA（Amazon のみ）を設定しています。
- ログ: Lambda の構造化ログ（実際のクライアント IP は CloudFront Function が付けるヘッダから記録し、トークンと本文は記録しません）、API と CloudFront と S3 のアクセスログ、WAF のログ（認証ヘッダと Cookie は伏せ字）、監査ログ（保持 400 日）。CloudTrail はアカウント既存のマルチリージョン証跡を使います。
- prod: AWS Backup（毎日、35 日保持、ボールトロック）、PITR、削除保護、RETAIN。

## dev / prod の分離（共有アカウント）

dev と prod を同じアカウントに置く場合、既定の CDK bootstrap では次の問題があります。bootstrap ロールは AdministratorAccess の実行ロールを持ち、deploy ロールはどのスタックでも更新・削除できます。そのため dev のパイプラインを奪われると、アカウント全体を握られます。MCPWiki はこれを次の仕組みで防いでいます。

1. **dev 専用の bootstrap**（qualifier `mwdev`、`scripts/bootstrap-dev.mjs`）。deploy、publishing、lookup、実行のすべてのロールに permissions boundary `MCPWikiDevBoundary` を付けます。
2. **dev のスタックが作るロールすべてに boundary を強制します**（スタックの `permissionsBoundary` に加え、CDK 内部のプロバイダのロールは synth 後の処理で補います）。boundary 自体が「boundary の付いていないロールの作成」を拒否するので、付け漏れがあればデプロイが失敗します（安全側に倒れます）。
3. **`MCPWikiDevBoundary`**（`src/infra/guard-stack.ts`、管理者が手動でデプロイ）の内容:
   - 使用するサービスだけを許可（EC2 などは拒否）
   - IAM の変更と PassRole は `MCPWiki-dev*` のロールだけ（boundary の付与が条件）。boundary の削除は拒否
   - AssumeRole は dev のロールと `cdk-mwdev-*` だけ（既定の bootstrap ロールへの昇格を遮断）
   - 他の CloudFormation スタックに属するリソースと、`mcpwiki:env=prod` タグの付いたリソースへの操作を拒否
   - prod のデータ（S3、DynamoDB、Lambda、SSM、ログ、Backup）と、既定の CDK アセットバケットを、名前でも拒否
   - Route 53 の変更は dev のホスト名配下だけ（同じゾーンにある他のサイトを守る）
4. **GitHub OIDC**: dev のロールは `environment:dev` かつ `ref:refs/heads/main` のときだけ引き受けられ、`cdk-mwdev-*` しか AssumeRole できません。prod のロールは `environment:prod` かつ `ref:refs/tags/v*` に限り、GitHub の承認も必要です。

IAM Policy Simulator で確認済みの結果: 境界下のロールからの prod スタックの更新、既定 bootstrap ロールの引き受け、IAM ユーザの作成、他のロールへのポリシー付与、prod のデータへのアクセス、他スタックのリソース操作、他のホスト名の DNS 変更は、すべて拒否されます。dev 自身の操作は許可されます。

**残るリスク:** CloudFormation 以外の方法で作られ、名前の規則にもタグにも当てはまらないリソース（手作業で作ったものなど）は、boundary の拒否条件に含まれません。完全に分離するには、アカウントを分けてください。

## 依存ライブラリの侵害（サプライチェーン）への対策

公開パッケージが侵害され、悪意あるコードが仕込まれる事態を想定しています。確実に検出する手段はないので、次の層を重ねて確率と影響範囲を下げています。

| 層 | 仕組み |
|---|---|
| すぐには取り込まない | Dependabot の cooldown（7 日、メジャー更新は 14 日）。CI でも公開から 7 日未満の版を拒否します（`scripts/supply-chain/review-lockfile.mjs`） |
| 怪しい兆候の検出 | 更新 PR ごとに npm レジストリを照会し、次を検査します: インストールスクリプトの追加、provenance（署名付きビルド証明）の欠落、レジストリ以外からの取得、sha512 以外の完全性ハッシュ（いずれも拒否）、公開者の変更と新規の推移的依存（警告）。`npm audit signatures` でレジストリ署名も検証します |
| 既知の悪性パッケージ | OSV-Scanner（OpenSSF malicious-packages を含む）を PR ごとと毎週実行し、取り込み済みの依存も継続的に照合します。例外は `osv-scanner.toml` に理由と期限（`ignoreUntil`）付きで記録し、期限を過ぎると再び失敗します |
| 実行時の依存は人が読む | ブラウザに同梱される依存（`marked` / `DOMPurify`）が変わると、旧版との差分を artifact に保存し、`runtime-deps-reviewed` ラベルが付くまで止めます |
| インフラへの影響 | 変更前後で CloudFormation を合成して比較します。依存だけの PR で IAM、ポリシー、CloudFront、Cognito などが変われば、`infra-diff-reviewed` ラベルが付くまで止めます。prod のリリース時は前回のタグとの差分を承認前に表示します（`scripts/supply-chain/template-diff.mjs`） |
| 権限の分離 | 依存のコードが動くジョブ（テスト、ビルド、synth、上記の検査）には認証情報がありません。AWS の認証情報を持つデプロイ用ジョブでは、`tools/deploy` の `aws-cdk` CLI（依存なしの 1 パッケージ）だけを `--ignore-scripts` でインストールし、合成済みのアセンブリをデプロイします（lint で検査） |

ラベルによる承認は、人が確認した結果を記録する手段です（`supply-chain-reviewed` は登録情報に関する指摘を受け入れます）。導入時の点検（バックフィル）では、公開から 7 日未満だった 12 パッケージを、`npm install --before` で 7 日以上前に公開された版に置き換えました。
**残るリスク:** 7 日以上気付かれない侵害や、正規の公開者による悪意ある変更は検出できない場合があります。OSV-Scanner のアクションが内部で使うコンテナイメージはタグ指定です。

## CI/CD と継続的なセキュリティレビュー

| 層 | 仕組み |
|---|---|
| コード | CodeQL (security-extended。CLI の仕様であるファイル↔HTTP の 2 ルールだけを `.github/codeql/codeql-config.yml` で理由付きで除外し、Windows の `.cmd` エディタ起動の 1 件だけを `codeql.yml` のゲートで「ルール + ファイル」を指定して理由付きで承認済みとして扱う。承認済みの指摘も notice として毎回出力するので、不要になれば気付けます)、独自の lint（XSS につながる API、トークンの保存先、依存の許可リスト、MCP / CLI の削除禁止、ログに秘密を残さない）、セキュリティ回帰テスト（`test/security.test.ts`） |
| 依存 | `npm audit`（実行時の依存）、`npm audit signatures`、Dependency Review（PR）、Dependabot（npm と Actions） |
| 秘密情報 | gitleaks（全履歴）、GitHub の Secret scanning と push protection |
| IaC | cdk-nag（AwsSolutions。例外はすべて理由を記録）、checkov（合成済みテンプレート。除外は `.checkov.yaml` に理由付きで記載） |
| パイプライン | zizmor、lint による「SHA 固定・`permissions` の明示・`id-token` は deploy ジョブのみ・`pull_request_target` 禁止」の検査、OpenSSF Scorecard |
| 実行環境 | デプロイ後のスモークテスト（ヘッダ、認証、リダイレクト）、OWASP ZAP baseline（毎週、dev）、AI セキュリティレビュー（任意、PR） |
| 公開時の情報管理 | Public リポジトリでは、ログ、サマリ、artifact を誰でも読めます。環境固有の値（アカウント ID、ホストゾーン、ホスト名、User Pool ID など）はマスクと伏せ字にし（`scripts/ci/mask.sh`、`scripts/ci/redact.mjs`）、合成済みのアセンブリは Environment シークレットを鍵に暗号化と改ざん検知を行います（`scripts/ci/seal.sh`、encrypt-then-MAC）。lint で強制しています |
| デプロイ | build / synth は認証情報なしで実行し、deploy ジョブだけが OIDC を使います（`--ignore-scripts`、キャッシュなし、合成済みアセンブリをそのままデプロイ） |

## 2026-10 のセキュリティレビュー（対応状況）

| 重大度 | 指摘 | 状態 |
|---|---|---|
| High | dev の CI ロールから CDK bootstrap を経由してアカウント全体を操作できる | 対応済み（dev / prod の分離） |
| High | サプライチェーン（タグ指定のアクション、install scripts、ワークフロー全体での id-token） | 対応済み |
| Medium | Markdown 処理の ReDoS | 対応済み（線形化と入力上限） |
| Medium | 往復できない frontmatter で記事が壊れる | 対応済み（検証、保存前の往復確認、壊れた文書でも読めるようにする） |
| Medium | CLI のトークンで権限を拡大できる | 対応済み（Web 以外は縮小のみ） |
| Medium | 検索で閲覧できない記事の内容を推測できる | 対応済み |
| Medium | 通知メールの購読が CI デプロイで消える / ログの不足 / 秘密が環境変数に平文 / 共有の同時実行枠 | 対応済み |
| Low | 過去の版の範囲、ID 衝突、境界の偽装、トークン失効の競合、レビュー済みの権限、MCP の書き込み制限、カーソル、再インデックス、リンクの判定、属性の書き換え、外部画像、バックアップ、CAA など | 対応済み |
| Low（受容） | WAF の本文ルールの一部が count のまま | 記事の本文に HTML やコード例が入るため。描画時の無害化と CSP で補っています |

## 既知の制約

- Cognito Plus（脅威保護）は使っていません（コストのため）。
- dev には WAF を付けていません（コストのため）。スロットリング、予約同時実行数、ユーザ単位のレート制限で補っています。
- オリジン用シークレットのローテーションは手動です（値を更新したあと再デプロイ。切り替えの間、短時間 403 が出ます）。
