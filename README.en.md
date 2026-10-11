# MCPWiki

English | [日本語](README.md)

A lightweight, serverless wiki designed to be used by LLMs through MCP.

- People use the **web UI**, LLMs use **MCP**, scripts use the **CLI / REST API**. All three can read, create, edit, search and list articles, and all three go through the same permission model.
- Articles are stored as **GitHub-flavored Markdown** with [**OKF (Open Knowledge Format) v0.2**](https://github.com/GoogleCloudPlatform/open-knowledge-format) frontmatter. They can be exported and imported as OKF bundles as-is.
- Links between articles, plus shared tags, form a **knowledge graph**. MCP exposes it through `get_graph` and `get_backlinks`.
- It runs on AWS serverless services with no always-on resources. The design is built around **mandatory MFA**, **least privilege** and **defense in depth**. Security review runs continuously in CI/CD.

## Architecture

![MCPWiki runtime architecture](docs/images/architecture.png)

| Role | Service | Notes |
|---|---|---|
| DNS / certificates | Route 53 + ACM (us-east-1) | One certificate covers `<host>` and `auth.<host>`. It is DNS-validated, so ACM renews it automatically. A CAA record restricts issuance to Amazon. |
| Delivery | CloudFront + S3 (OAC) | TLS 1.2+, CSP, HSTS. Requests to `*.cloudfront.net` are redirected to the canonical host. |
| Protection | AWS WAF (prod) | Per-IP rate limit, AWS managed rules, logging with credentials redacted |
| Authentication | Cognito User Pool (Essentials, managed login) | TOTP MFA required, invitation only, groups `admin` / `editor` / `viewer` |
| API / MCP | API Gateway HTTP API + Lambda (Node.js 24, arm64) | One function serves both REST and MCP Streamable HTTP. JWTs are verified inside the Lambda. |
| Data | DynamoDB (on-demand, PITR) | Metadata, search inverted index, links (graph), history, audit log, rate limits |
| Content | S3 (versioning) | Each article is an OKF document at `articles/<id>.md`, and S3 object versions serve as the history. The Lambda has no permission to delete objects. |
| Backup | AWS Backup (prod) | Daily backups kept for 35 days, in a vault with a lock (minimum 7 days) |

Search doesn't use OpenSearch. It uses a custom inverted index in DynamoDB: CJK text is indexed as character bigrams and other text as words. The graph doesn't use Neptune and is also stored in DynamoDB. Both choices keep costs down.

### Dependencies

There are only two runtime dependencies: `marked` for Markdown rendering and `DOMPurify` for XSS protection. The YAML frontmatter parser, JWT verification, ZIP handling, MCP server and CLI are all built on Node's standard library. `npm run lint` checks that no other runtime dependency has been added.

## Permission model

Each article has a **read scope** and a **write scope**. All permission checks live in `src/shared/permissions.ts`, and the API, MCP and UI all use them.

| Setting | Values |
|---|---|
| `readScope` | `admin` (admins only) / `owner` (the creator) / `all` (every signed-in user) |
| `writeScope` | `none` (read-only) / `admin` / `owner` / `all` (every editor) |

- Admins can always read and edit. Viewers can never edit. Creating articles requires the editor role or higher. The write scope can never be wider than the read scope.
- An article you can't read never shows up anywhere: not in lists, search, tags, the graph, backlinks or history. Opening it directly returns 404. Search scores and list cursors don't reveal that it exists either.
- Each past revision is also checked against the scope it was written under, so widening an article's scope doesn't expose earlier private versions.
- **Deleting is only possible from the web UI.** Deletion is a soft delete, and admins can restore articles. MCP and the CLI have no delete feature, and the server also rejects delete requests from any token that wasn't issued to the web client.
- **Permissions can only be widened from the web UI.** CLI, MCP and API tokens can only narrow them. This means a prompt-injected agent with shell access still can't make articles public.
- Edits use **optimistic locking**: if your `version` doesn't match the current one, the server returns 409.

## UI and help pages

- A sidebar is always visible on the left: navigation, help, recently updated articles and tags. On narrow screens, toggle it with ☰.
- On first start, two help articles are created automatically: `help-wiki` (how to use MCPWiki) and `help-markdown` (Markdown guide; the pages are in Japanese). Everyone can read them; only admins can edit them. While nobody has edited a page, updates to its source are applied after a deploy. Pages that an admin has edited or deleted are left alone (never re-created or overwritten). The sources are `src/backend/seed/*.md`; run `node scripts/gen-seed.mjs` after changing them (lint checks that the generated file is up to date).
- The footer shows the MCPWiki version (the tag name for releases, `git describe` otherwise) and a link to GitHub.

## Admin features

- **Site title:** change it under Admin → Site settings (up to 60 characters). It is used in the header, the browser tab and the `index.md` of exports. The sign-in screen keeps showing "MCPWiki".
- **Bulk actions on articles:** under Admin → Articles, pick articles with checkboxes (filter, select all shown, load all) and either mark them as reviewed or set their read / write scopes to given values (widening included). The confirmation says how many articles would be widened. Each article goes through the same checks as a normal edit (the write scope can't be wider than the read scope, and so on) and gets its own history entry and audit record. Failures are listed with their reason and don't stop the other articles. Only admins in the web UI can use this.
- **Download all articles:** Admin → OKF import/export → "Download all articles as ZIP" downloads every live article (whatever its read scope; deleted articles are excluded) as an OKF bundle: `index.md` plus `wiki/<id>.md` files with frontmatter. The bundle can be imported as is. Attachments are not included. The ZIP is written to `exports/` in S3 and handed out as a presigned URL valid for 5 minutes; a lifecycle rule deletes it after one day. Only admins in the web UI can use it (not the CLI or MCP), and each export is recorded in the audit log as `export-all`.

## Attachments (images and PDF)

- **Allowed:** PNG, JPEG, GIF, WebP and PDF, up to 10 MB per file and 100 files per article. SVG and HTML are rejected because they can carry script.
- **Adding files in the editor:** use "Attach image / PDF", drag & drop, or paste. Each file inserts `![name](/wiki/<article-id>/files/<file-id>)` at the cursor; PDFs are inserted as plain links.
- **Access follows the article.** Viewing an attachment needs read access to its article; uploading and deleting need write access. Attachments of a private article stay private even if someone has the URL.
- **Transfer:** bytes never pass through Lambda. Clients exchange files directly with S3 using presigned URLs that are valid for 5 minutes and pinned to one key, type and size.
- **Verification:** after an upload, the server checks the file's magic bytes against the declared type and discards mismatches. Images are shown inline; PDFs are always served as downloads.
- **Deletion:** web UI only. S3 versioning lets an administrator recover deleted files.
- **CLI:** `mcpwiki attach <id> <file>`, `mcpwiki attachments <id>`, `mcpwiki download <id> <file-id>`.
- **MCP:** `list_attachments`, and `get_attachment`, which returns images up to 3 MB as image content. Uploading through MCP is not possible.

## Setup

**[docs/deploy.en.md](docs/deploy.en.md)** walks through building MCPWiki in your own AWS account and deploying it automatically from GitHub Actions: prerequisites, values to change in a fork, the first deployment, the first admin, CI setup, prod releases, troubleshooting and teardown.

In short:

```bash
npm ci --ignore-scripts && npm test && npm run lint
npx cdk bootstrap aws://<account>/<region> aws://<account>/us-east-1   # bootstrap for prod
npx cdk deploy MCPWiki-guard && node scripts/bootstrap-dev.mjs         # shared-account guard rails and the dev-only bootstrap
npm run deploy:dev                                                     # dev (custom domains: config/domains.local.json)
scripts/create-admin.sh dev <username> <email> admin                   # invite the first admin
```

After that, merging to `main` deploys dev and pushing a `v*` tag (two approvals) deploys prod.

## CI/CD and continuous security review

![CI/CD and isolation](docs/images/cicd-security.png)

| Workflow | Runs on | What it does |
|---|---|---|
| `ci.yml` | PR / main | lint (dependencies, XSS, pinned workflow actions), type check, tests (including security regression tests), `cdk synth` with **cdk-nag**, `npm audit`, `npm audit signatures` |
| `security.yml` | PR / main / weekly | **gitleaks** (secrets across the full history), **OSV-Scanner** (known vulnerable and malicious packages), **Dependency Review** (PRs), **checkov** (synthesized templates), **zizmor** (GitHub Actions audit), **OWASP ZAP** baseline (against dev, weekly), optional **AI review by Claude** |
| `supply-chain.yml` | PRs that change dependencies | **Lockfile review**: blocks versions younger than 7 days, new install scripts, dropped provenance and non-registry sources; warns on publisher changes and new packages; saves runtime dependency diffs. **Infrastructure diff**: synthesizes base and PR and compares them; a dependency-only PR that changes security-relevant resources is blocked. |
| `codeql.yml` | PR / main / weekly | **CodeQL** (security-extended, TypeScript and GitHub Actions) |
| `scorecard.yml` | main / weekly | **OpenSSF Scorecard** |
| `deploy.yml` | main → dev, `v*` tags → prod | Build and synth run in a job that has no cloud credentials. Only the deploy job can get an OIDC token, and it installs with `npm ci --ignore-scripts` and no cache. |

**Private repositories:** code scanning (SARIF upload), Dependency Review and secret scanning need paid GitHub features (GitHub Code Security / Secret Protection). By default the workflows don't use them. Each scanner, CodeQL included, fails its job when it finds something and keeps the report as an artifact. Once the repository is public, or you have the paid features, set the repository variable `CODE_SCANNING_ENABLED=true` and the results are collected in GitHub's Security tab (code scanning). On private repositories, rulesets (branch protection) and environment required reviewers may also depend on your plan.

 Every action is pinned to a commit SHA, and Dependabot keeps the pins up to date.

For the one-time GitHub setup (OIDC, secrets, Environments) and the protection settings for a public repository (rulesets, tag protection, PRs from forks), see [docs/deploy.en.md](docs/deploy.en.md#6-deploy-from-github-actions). Anyone can open issues and pull requests; only people with write access (maintainers) can merge. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute.

## CLI

```bash
npm run build
install -m 755 dist/cli/mcpwiki.mjs ~/.local/bin/mcpwiki     # single file, no dependencies

mcpwiki configure --env dev --url https://wiki-dev.example.com
mcpwiki login                     # browser sign-in with MFA (PKCE)
mcpwiki list --tag aws
mcpwiki search "lambda cold start"
mcpwiki get <id>                  # prints the OKF document (frontmatter + Markdown)
mcpwiki create --title "Runbook" --tags ops,aws --file doc.md
mcpwiki edit <id>                 # edit the OKF document in $EDITOR (optimistic locking)
mcpwiki graph <id> --depth 2 --tags
mcpwiki export --out bundle.zip   # OKF bundle of every article you can read
mcpwiki attach <id> shot.png      # attach (paste the printed Markdown into the article)
mcpwiki attachments <id>          # list attachments
mcpwiki download <id> <file-id>   # save an attachment
```

If your browser runs on a different machine, sign in and then paste the final `http://localhost:53682/callback?...` URL into the CLI. Tokens are saved to `~/.config/mcpwiki/credentials.json` (mode 0600) and refreshed automatically.

### Windows

The CLI and the MCP bridge run on Windows as they are (the `npm test` end-to-end suite passes there too). You need [Node.js](https://nodejs.org/) 20 or later and Git.

```cmd
git clone https://github.com/siseru/mcpwiki.git
cd mcpwiki
npm ci --ignore-scripts
npm run build
npm install -g .                  :: gives you an "mcpwiki" command (npm writes mcpwiki.cmd)
mcpwiki configure --env dev --url https://wiki-dev.example.com
mcpwiki login
```

Calling `node dist\cli\mcpwiki.mjs <command>` directly works just as well. What differs on Windows:

- Configuration and tokens live in `%APPDATA%\mcpwiki\` (or `XDG_CONFIG_HOME` if you set it). There is no equivalent of the POSIX `0600`; the files inherit the ACL of your user profile.
- `mcpwiki login` opens your default browser through `rundll32.exe url.dll,FileProtocolHandler`. Use `--no-browser` to open the URL yourself.
- `mcpwiki edit <id>` defaults to `notepad.exe`. Quote a `VISUAL` / `EDITOR` path that contains spaces, e.g. `set EDITOR="C:\Program Files\Notepad++\notepad++.exe" -multiInst`; `.cmd` wrappers such as `code --wait` work too. The editor must **wait** until you close the file.
- Markdown passed to `--file` may use CRLF and start with a BOM; both are normalized on read.
- `npm run build` / `npm test` / `npm run lint` / `npm run typecheck` / `npm run synth` all work from cmd or PowerShell, and CI runs lint, typecheck and the tests on `windows-latest`. Only `scripts/create-admin.sh` needs bash (run it from Git Bash or WSL).

## MCP

The easiest way to connect an MCP client is the stdio bridge built into the CLI (`mcpwiki mcp`). It uses the CLI's stored credentials and refreshes tokens automatically. Sign in with the CLI first, so that `mcpwiki whoami` works:

```bash
mcpwiki configure --env dev --url https://wiki-dev.example.com
mcpwiki login --env dev
```

### Claude Code

```bash
claude mcp add --scope user mcpwiki -- mcpwiki mcp --env dev
claude mcp list            # mcpwiki should show as Connected
```

On Windows, `mcpwiki` is `mcpwiki.cmd`, which MCP clients may fail to start. Start the `.mjs` with `node` instead (adjust the path to where you cloned the repository):

```cmd
claude mcp add --scope user mcpwiki -- node C:\Users\<user>\mcpwiki\dist\cli\mcpwiki.mjs mcp --env dev
```

- `--scope user` makes the server available in every directory. Use `--scope project` to register it for one repository only.
- Restart Claude Code after adding the server, then run `/mcp` to see the connection status and the tool list.
- Example prompts: "Find the MCPWiki articles about istus and summarize them", "Write today's work up as a new MCPWiki article tagged worklog".

### Kiro

Add the server under `mcpServers` in `~/.kiro/settings/mcp.json` (all workspaces) or in the workspace's `.kiro/settings/mcp.json`. Keep any servers that are already there.

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

- Use **absolute paths** for `node` and `mcpwiki`, because Kiro may start servers without `~/.local/bin` on the PATH. `which node` and `which mcpwiki` print the paths.
- On Windows, put `dist\cli\mcpwiki.mjs` from your clone in `args`, not `mcpwiki.cmd` (the path `where mcpwiki` prints). `where node` prints the path of `node.exe`. Backslashes are written as `\\` in JSON:

  ```json
  "command": "C:\\Program Files\\nodejs\\node.exe",
  "args": ["C:\\Users\\<user>\\mcpwiki\\dist\\cli\\mcpwiki.mjs", "mcp", "--env", "dev"],
  ```
- Put only the read-only tools in `autoApprove`. Kiro will then ask before running `create_article` or `update_article`.
- After saving, open MCP SERVERS in the Kiro panel and check that `mcpwiki` is connected and lists 10 tools. Reconnect if it doesn't.

### Common notes

- Articles created through MCP are saved as `draft`. After checking one, use "Mark as reviewed" in the web UI to record that a person reviewed it.
- MCP cannot delete articles or widen read/write scopes. Only the web UI can do that.
- If you see `session expired`, run `mcpwiki login` again. Refresh tokens are valid for 7 days.

The remote endpoint is `https://<host>/mcp` (Streamable HTTP). Unauthenticated requests get a 401 with an RFC 9728 `WWW-Authenticate: Bearer resource_metadata=...` header. The authorization server is Cognito, using PKCE with the pre-registered client `cliClientId` and the callback `http://localhost:53682/callback`.

| Tools | Description |
|---|---|
| `list_articles` / `get_article` / `search_articles` | List articles, get an OKF document (including past versions), full-text search |
| `create_article` / `update_article` | Create (defaults to `status: draft`), partial update (`version` required; permissions can only be narrowed) |
| `list_tags` / `get_graph` / `get_backlinks` | Tags, relationship graph (`link` edges are directed; `tag` edges mean shared tags), backlinks |
| `list_attachments` / `get_attachment` | List attachments; get an image (up to 3 MB; PDFs return metadata only) |

Article content is treated as untrusted data. Each response wraps it in a randomly named boundary tag.

## OKF

```markdown
---
type: Wiki Article
title: Tokyo Tower
description: Overview of the 1958 broadcasting tower
tags: [travel, history]
status: stable
generated: { by: "human:taro", at: "2026-10-07T00:00:00.000Z" }
verified:
  - by: "human:hanako"
    at: "2026-10-08T00:00:00.000Z"
mcpwiki: { id: tokyo-tower, owner: taro, read_scope: all, write_scope: owner, version: 3, ... }
---

Body… [related](/wiki/other-article)
```

- Link to other articles with `[label](/wiki/<id>)`. `/wiki/<id>.md` and relative `<id>.md` links are recognized too.
- `generated.by` is `human:<user>` for web and CLI edits, and `mcpwiki-mcp/<version>` for MCP edits. "Mark as reviewed" adds an entry to `verified`, and content changes reset it.
- Extension keys are preserved. An exported bundle contains `index.md` (with `okf_version: "0.2"`) and `wiki/<id>.md` files.

## Cost

At small scale (tens of users, thousands of articles), dev costs a few USD per month. prod adds WAF (about 9 USD per month), WAF logs and Backup (which scales with data size), for an expected total of about 10–20 USD per month. There are no always-on resources.

Every resource carries the cost allocation tags `Project=mcpwiki`, `Environment=dev|prod` (`shared` for the guard and CI stacks), `Component=app|edge|cicd|guard` and `ManagedBy=cdk`. To group costs by them in Cost Explorer, activate the keys under Billing → Cost allocation tags (once, in the management account; new tags can take up to 24 hours to appear there). Add or override tags with `-c costTags='{"CostCenter":"..."}'`.

## Layout

```
src/shared   permissions, OKF, YAML subset, tokenizer, validation (shared by API / web / CLI)
src/backend  Lambda: routing, JWT verification, business logic, MCP, DynamoDB/S3 store, ZIP
src/web      SPA (user and admin UI)
src/cli      mcpwiki CLI and MCP stdio bridge
src/infra    CDK: WikiStack / EdgeStack / GuardStack / CiStack
test         node:test (E2E and security regression tests)
scripts      build / lint / smoke / create-admin / bootstrap-dev / diagrams
docs         design documents and diagrams
```

Security design: [docs/security.en.md](docs/security.en.md) / reporting vulnerabilities: [SECURITY.md](SECURITY.md)

## License

Apache License 2.0 ([LICENSE](LICENSE))
