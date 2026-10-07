# Security design and threat model

English | [日本語](security.md)

## Assets

- Article confidentiality (`readScope`) and integrity (`writeScope`, history)
- Accounts (MFA, tokens)
- The platform: AWS resources, the deployment path, and everything else in the shared account

## Authentication

- **Cognito user pool**
  - MFA is mandatory and TOTP is the only method.
  - Sign-up is by invitation only.
  - Passwords need 12+ characters drawn from 4 character classes.
  - An e-mail change takes effect only after the new address is verified (`keepOriginal`).
  - Users cannot write their own attributes.
- **Managed login with PKCE**
  - Both the web and CLI clients are public clients.
  - The only enabled auth flow is `ALLOW_REFRESH_TOKEN_AUTH`; SRP and the password APIs are disabled.
  - Access tokens last 1 h. Refresh tokens last 12 h for the web client and 7 days for the CLI.
- **Token verification** happens in the Lambda (`src/backend/auth.ts`). It checks:
  - the RS256 signature against the JWKS
  - `iss`
  - `token_use=access`
  - `exp` / `iat`
  - that `client_id` is on the allowlist
- **Revocation:** a role change or disable writes `minIat = now + 1` both before and after the Cognito calls. Tokens issued earlier are rejected immediately.
- **Browser storage:** web tokens are kept in `sessionStorage`. lint forbids `localStorage`.

## Authorization

- All checks live in `src/shared/permissions.ts`, and tests cover the full permission matrix.
- **Articles you can't read are indistinguishable from missing ones:**
  - Requests for them return 404.
  - Search ranks only candidates you can read, so scores can't act as an oracle.
  - List cursors are AES-GCM encrypted.
  - An id collision returns a generic message and writes nothing to S3.
- Past revisions are also checked against the `readScope` they were written with.
- These operations require the web client token:
  - delete and restore
  - user administration
  - import
  - reindex
- Marking an article as reviewed requires write permission on it.
- **Permissions can only be widened from the web UI.** CLI, MCP and API tokens can only narrow them.
- **Input validation** happens in `src/shared/validate.ts`:
  - size limits
  - no C0, C1 or bidi control characters
  - reserved extension keys, and `__proto__` and similar keys at any depth, are rejected
  - every document is serialized and parsed back before it is stored, and must round-trip

## Web (XSS / clickjacking)

- **Rendering:** marked converts Markdown, DOMPurify sanitizes the result, and CSP restricts the page:
  - `script-src 'self'`
  - `img-src 'self' data:`
  - `object-src 'none'`
  - `frame-ancestors 'none'`
  - `base-uri 'none'`
- The DOM is built with `textContent` only, and lint forbids `innerHTML`.
- **Links and images** are classified by the origin the browser actually resolves, which defeats tricks such as `/\evil.com`.
- **External images** are blocked by the CSP, so they can't be used to track readers.
- **Security headers:** HSTS, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` and COOP.

## MCP / LLM-specific threats

| Threat | Mitigation |
|---|---|
| Prompt injection in article content | Content is wrapped in a randomly named boundary tag in every response, so the body can't forge the end of the untrusted region. Server instructions say to treat content as data. |
| Injected permission widening | Only the web UI can widen permissions; this covers CLI tokens too, not just MCP. |
| Injected deletion | There is no delete tool, and the server rejects deletes from any non-web token. |
| LLM overwriting others' edits | Optimistic locking, S3 version history, `draft` as the default status for MCP-created articles, and `generated.by` provenance |
| Abuse / DoS | Per-user rate limits (MCP writes count as writes), bounded graph traversal, linear-time Markdown helpers (ReDoS-safe), reserved Lambda concurrency |
| DNS rebinding | `Origin` is validated on `/mcp`. |

## Infrastructure

- **S3:** public access is blocked, SSL is enforced and data is encrypted. The web bucket is reachable only through OAC, and the Lambda has no delete permission.
- **Direct execute-api access is blocked.** CloudFront adds an origin secret header that the Lambda verifies. The Lambda reads the secret from Secrets Manager at runtime, so it never appears in the function configuration.
- **Lambda:** the IAM role is least-privilege. Reserved concurrency (dev 20 / prod 100) keeps a flood from exhausting the shared account pool.
- **TLS and DNS:**
  - TLS 1.2 or higher
  - the ACM certificate renews automatically (DNS validation)
  - an alarm warns before the certificate expires
  - CAA records allow only Amazon to issue certificates
- **Logs:**
  - Structured Lambda logs record the real client IP from a header set by a CloudFront Function. They never include tokens or request bodies.
  - API, CloudFront and S3 access logs.
  - WAF logs, with `authorization` and `cookie` redacted.
  - The audit log is kept for 400 days.
  - The account's existing multi-region CloudTrail.
- **prod data:**
  - AWS Backup runs daily, keeps 35 days and uses a locked vault.
  - DynamoDB PITR.
  - Deletion protection and RETAIN on the data resources.

## dev / prod isolation (shared account)

The default CDK bootstrap is unsafe when dev and prod share one account. Its execution role has AdministratorAccess, and its deploy role can update or delete any stack. Taking over the dev pipeline would therefore mean taking over the whole account. MCPWiki prevents this as follows.

1. **A dev-only bootstrap** (qualifier `mwdev`, created by `scripts/bootstrap-dev.mjs`). Every bootstrap role carries the `MCPWikiDevBoundary` permissions boundary: deploy, publishing, lookup and execution.
2. **Every role created by a dev stack also carries the boundary.**
   - The stack's `permissionsBoundary` covers ordinary roles.
   - CDK-internal provider roles get it from a post-synth patch.
   - The boundary itself denies creating roles without it, so anything missed fails the deploy instead of weakening the boundary.
3. **What `MCPWikiDevBoundary` allows and denies** (`src/infra/guard-stack.ts`, deployed by an administrator):
   - Only the services this system uses are allowed. EC2, for example, is denied.
   - IAM changes and PassRole are allowed only for `MCPWiki-dev*` roles, and only when the boundary is attached. Removing the boundary is denied.
   - AssumeRole is allowed only for dev roles and `cdk-mwdev-*`. This blocks escalation through the default bootstrap roles, which trust the account root.
   - Resources that belong to other CloudFormation stacks, or that are tagged `mcpwiki:env=prod`, are denied.
   - prod data (S3, DynamoDB, Lambda, SSM, logs, Backup) and the default CDK asset bucket are also denied by name.
   - Route 53 changes are allowed only for the dev host and names under it. This protects the other sites that share the hosted zone.
4. **GitHub OIDC trust:**
   - The dev role requires `environment:dev` and `ref:refs/heads/main`, and it can assume only `cdk-mwdev-*`.
   - The prod role requires `environment:prod` and `ref:refs/tags/v*`, plus approval from a GitHub reviewer.

Verified with the IAM policy simulator. A role under the boundary is denied when it tries to:

- update a prod stack
- assume a default bootstrap role
- create an IAM user
- attach a policy to an unrelated role
- read prod data
- touch resources owned by another stack
- change DNS records outside the dev host

Operations on dev's own resources are allowed.

**Residual risk:** resources that weren't created by CloudFormation and that match no naming or tag rule (for example, resources created by hand) aren't covered by the deny statements. Use separate accounts for complete isolation.

## CI/CD and continuous security review

| Layer | Mechanism |
|---|---|
| Code | CodeQL (security-extended; only the two file↔HTTP rules that describe the CLI's intended behavior are excluded, with reasons, in `.github/codeql/codeql-config.yml`); custom lint for XSS sinks, token storage, the dependency allowlist, no deletion via MCP/CLI, and no secrets in logs; security regression tests (`test/security.test.ts`) |
| Dependencies | `npm audit` (runtime), `npm audit signatures`, Dependency Review (PRs), Dependabot (npm and Actions) |
| Secrets | gitleaks over the full history; GitHub secret scanning with push protection |
| IaC | cdk-nag AwsSolutions (every acknowledgement has a reason); checkov on the synthesized templates (every skip in `.checkov.yaml` has a reason) |
| Pipeline | zizmor; lint requiring SHA-pinned actions, explicit `permissions`, `id-token` only in deploy jobs, and no `pull_request_target`; OpenSSF Scorecard |
| Runtime | Post-deploy smoke tests (headers, authentication, redirects); weekly OWASP ZAP baseline against dev; optional AI security review on PRs |
| Deployment | Build and synth run without credentials. Only the deploy job uses OIDC, with `--ignore-scripts`, no cache, and the pre-synthesized assembly. |

## 2026-10 security review: status

| Severity | Finding | Status |
|---|---|---|
| High | The dev CI role could control the whole account through the CDK bootstrap roles | Fixed (dev / prod isolation) |
| High | Supply chain: tag-pinned actions, install scripts, workflow-wide id-token | Fixed |
| Medium | ReDoS in the Markdown helpers | Fixed (linear patterns, input caps) |
| Medium | Frontmatter that doesn't round-trip could break an article | Fixed (validation, pre-store round-trip check, tolerant reader) |
| Medium | Permissions could be widened with a CLI token | Fixed (non-web channels can only narrow) |
| Medium | Search acted as an oracle for unreadable content | Fixed |
| Medium | CI deploys dropped alarm subscriptions; logging gaps; plaintext secret in env; shared concurrency pool | Fixed |
| Low | Revision scope, id collisions, boundary spoofing, revocation race, verify rights, MCP write limits, cursors, reindex, link classification, attribute writes, external images, backups, CAA and others | Fixed |
| Low (accepted) | Some WAF body rules stay in count mode | Article bodies legitimately contain HTML and code samples. Mitigated by sanitized rendering and the CSP. |

## Known limitations

- Cognito Plus (threat protection) is not used, for cost reasons.
- dev has no WAF, for cost reasons. Throttling, reserved concurrency and per-user rate limits partly make up for it.
- Rotating the origin secret is manual: update the value, then redeploy. Expect a few 403s during the cutover.
