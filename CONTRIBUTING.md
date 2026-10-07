# Contributing to MCPWiki

[日本語は下にあります](#コントリビューションについて日本語)

Thanks for your interest! Issues and pull requests are welcome. Only maintainers can merge.

## Reporting

- **Bugs / feature requests:** open an issue using the templates.
- **Security vulnerabilities: do not open a public issue.** Use *Security → Report a vulnerability* (see [SECURITY.md](SECURITY.md)).

## Pull requests

1. Fork the repository and create a branch from `main`.
2. `npm ci` then make your change. Keep runtime dependencies to the approved set (`marked`, `dompurify`) — `npm run lint` enforces it.
3. Run the same checks as CI:
   ```bash
   npm run lint
   npm run typecheck
   npm test
   npx cdk synth --quiet     # needs CDK_DEFAULT_ACCOUNT=123456789012 (any 12 digits); includes cdk-nag
   ```
4. Add or update tests (`test/`). Security-relevant changes need a regression test (`test/security.test.ts`).
5. Open the PR and fill in the template. CI, Security, CodeQL (and Supply chain for dependency changes) must pass.

Workflows on pull requests from forks run without secrets or cloud credentials, and a maintainer may need to approve the first run.
Please never include real account ids, domains, hosted zone ids, tokens or e-mail addresses in code, tests, issues or logs.

## Design rules (checked by lint / tests)

- Authorization lives only in `src/shared/permissions.ts`; unreadable articles must look like missing ones.
- The web app never writes HTML strings into the DOM (`innerHTML` etc. are forbidden).
- MCP and the CLI cannot delete articles or widen permissions.
- GitHub Actions are pinned to full commit SHAs; `pull_request_target` is not allowed.

By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE).

---

## コントリビューションについて（日本語）

Issue と Pull Request を歓迎します。マージはメンテナが行います。

- **バグ報告・機能要望:** テンプレートを使って Issue を作成してください。
- **脆弱性は公開の Issue にしないでください。** 「Security → Report a vulnerability」から報告してください（[SECURITY.md](SECURITY.md)）。
- **PR の前に**、CI と同じ検査（`npm run lint`、`npm run typecheck`、`npm test`、`npx cdk synth --quiet`）を通してください。セキュリティに関わる変更には、回帰テストを追加してください。
- 実行時の依存は `marked` と `dompurify` だけです。追加には事前の相談が必要です。
- 実在のアカウント ID、ドメイン、ホストゾーン ID、トークン、メールアドレスを、コード、テスト、Issue、ログに含めないでください。
- fork からの PR のワークフローは、シークレットも認証情報もない状態で実行されます。初回はメンテナの承認が必要な場合があります。

貢献いただいた内容は [Apache License 2.0](LICENSE) で提供されることに同意したものとみなします。
