# Deployment guide

English | [日本語](deploy.md)

This guide takes you from an empty AWS account to automatic deployments of dev and prod from GitHub Actions. Plan on 1–2 hours for the first run, including the wait for DNS and certificates.

- [Overview](#overview)
- [0. Prerequisites](#0-prerequisites)
- [1. Prepare the repository](#1-prepare-the-repository)
- [2. Prepare the AWS account (once, administrator)](#2-prepare-the-aws-account-once-administrator)
- [3. Custom domain (optional)](#3-custom-domain-optional)
- [4. Deploy dev from your machine](#4-deploy-dev-from-your-machine)
- [5. Create the first admin](#5-create-the-first-admin)
- [6. Deploy from GitHub Actions](#6-deploy-from-github-actions)
- [7. Release to prod](#7-release-to-prod)
- [8. Protect the GitHub repository](#8-protect-the-github-repository)
- [9. Operations](#9-operations)
- [10. Troubleshooting](#10-troubleshooting)
- [11. Tearing down](#11-tearing-down)

## Overview

| Step | Who | Where | What |
|---|---|---|---|
| 1–3 | Administrator | Your machine | Fork, AWS foundations (permissions boundary, bootstrap), domain settings |
| 4–5 | Administrator | Your machine | First dev deployment and the first admin user |
| 6 | Administrator | Your machine + GitHub | CI roles, OIDC, secrets, Environments |
| 7 onward | Maintainers | GitHub | Merging to `main` deploys dev; pushing a `v*` tag (two approvals) deploys prod |

dev and prod are assumed to share **one AWS account**. A permissions boundary and a dev-only CDK bootstrap keep a compromised dev pipeline from reaching prod or anything else in the account ([docs/security.en.md](security.en.md#dev--prod-isolation-shared-account)). If you put dev in a separate account, the same steps still work; the boundary is just an extra restriction there.

## 0. Prerequisites

| What | Used for |
|---|---|
| An AWS account and administrator credentials | Steps 2–6 (after that, CI deploys with OIDC) |
| [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) | `aws sts get-caller-identity` must work |
| Node.js 20 or later (CI uses 24) and npm | Build, tests, CDK |
| Git and the [GitHub CLI](https://cli.github.com/) (`gh`) | Forking and the GitHub settings in step 6 |
| A public Route 53 hosted zone (optional) | Custom domains (step 3) |
| `openssl` | Generating encryption keys (step 6) |

The region is `context.region` in `cdk.json` (default `us-west-2`); change it first if you want another one. The CloudFront certificate and the WAF always live in `us-east-1`.

> **Note:** The MCPWiki scripts use the region from `cdk.json` even if your shell sets `AWS_REGION` / `AWS_DEFAULT_REGION`. Pass `--region` when you run `aws` commands yourself.

## 1. Prepare the repository

Fork the repository (or copy it into your own) and clone it:

```bash
gh repo fork siseru/mcpwiki --clone
cd mcpwiki
npm ci --ignore-scripts
npm test          # unit and end-to-end tests (API / MCP / CLI)
npm run lint      # repository security policy checks
```

In a fork, change these values to your own:

| File | Value | If you don't |
|---|---|---|
| `package.json` | `repository.url` | The GitHub link in the footer points at the upstream repository |
| `cdk.json` | `context.githubOidcSubjectPrefix` | You cannot create the CI roles (set in step 6; synth refuses the upstream value) |
| `.github/CODEOWNERS` | `@siseru` | Review requests go to the upstream maintainer |
| `.github/ISSUE_TEMPLATE/config.yml` | Vulnerability report URL | Reports go to the upstream repository |

`githubOidcSubjectPrefix` pins the CI roles to a repository **by its numeric ids**. If you created the CI roles with the upstream value, the roles in your AWS account would trust the upstream repository's workflows. To prevent that, synth fails unless the names in the prefix match `githubRepo`. Leave it empty (`""`) until step 6.

## 2. Prepare the AWS account (once, administrator)

Run these with administrator credentials:

```bash
npm run build
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION=$(node -p "require('./cdk.json').context.region")

# CDK bootstrap for prod (default qualifier); us-east-1 is needed for the certificate and WAF
npx cdk bootstrap "aws://$ACCOUNT/$REGION" "aws://$ACCOUNT/us-east-1"

# Shared-account guard rails (permissions boundary MCPWikiDevBoundary)
npx cdk deploy MCPWiki-guard

# dev-only bootstrap (qualifier mwdev); every bootstrap role gets the boundary
node scripts/bootstrap-dev.mjs
```

- CI never runs `MCPWiki-guard` or `bootstrap-dev.mjs`. Only administrators change the boundary.
- If you use a custom domain, create the configuration file from step 3 **before** deploying the guard: the boundary allows Route 53 changes only for the dev host name. If you add it later, deploy the guard again.

## 3. Custom domain (optional)

Copy `config/domains.example.json` to `config/domains.local.json`. Git ignores this file, so hosted zone details never enter the repository.

```json
{ "zoneName": "example.com", "hostedZoneId": "Z0123456789EXAMPLE", "hosts": { "dev": "wiki-dev.example.com", "prod": "wiki.example.com" } }
```

- The `MCPWiki-<env>-edge` stack in `us-east-1` creates the ACM certificate (`<host>` and `auth.<host>`) and CAA records. The DNS validation records stay in place, so the certificate **renews automatically**. An alarm fires when fewer than 30 days remain.
- The sign-in screen is served from `auth.<host>` (a Cognito custom domain). Requests to `*.cloudfront.net` get a 308 redirect to `<host>`.
- Without this file, MCPWiki runs on the `*.cloudfront.net` domain.
- For CI, put the file's content as one line of JSON into the secret `MCPWIKI_DOMAINS` (step 6).

## 4. Deploy dev from your machine

```bash
npm run deploy:dev     # MCPWiki-dev-edge and MCPWiki-dev (15–30 minutes the first time)
```

- When CDK asks you to confirm IAM changes, review them and answer `y`.
- At the end it prints `MCPWiki-dev.Url`. Check it with the smoke test (what can be checked without signing in: headers, 401s, redirects):

  ```bash
  node scripts/smoke.mjs https://wiki-dev.example.com
  ```

- On first start, the help articles (`help-wiki` and `help-markdown`) are created automatically.

## 5. Create the first admin

```bash
scripts/create-admin.sh dev <username> <email> admin
```

1. A temporary password arrives by e-mail. Open the site, sign in and change the password (12+ characters from 4 character classes).
2. Scan the QR code with an authenticator app (Google Authenticator, 1Password, …) to register TOTP. MFA is mandatory.
3. Invite everyone else from Admin → Users in the web UI.

## 6. Deploy from GitHub Actions

### 6.1 CI roles

```bash
REPO=<owner>/<repo>

# Include the ref in the OIDC sub (the roles require both environment and ref)
gh api -X PUT repos/$REPO/actions/oidc/customization/sub \
  --input - <<< '{"use_default":false,"include_claim_keys":["repo","context","ref"]}'
gh api repos/$REPO/actions/oidc/customization/sub --jq .sub_claim_prefix
```

Put the printed value (shaped like `repo:<owner>@<owner-id>/<repo>@<repo-id>`) into `context.githubOidcSubjectPrefix` in `cdk.json`, commit it, and create the CI roles:

```bash
npm run build
npx cdk deploy MCPWiki-ci -c githubRepo=$REPO
```

Note the outputs `DeployRoleArndev` and `DeployRoleArnprod`. The dev role can only be assumed with `environment:dev` and `ref:refs/heads/main`, the prod role only with `environment:prod` and `ref:refs/tags/v*`. Because they are pinned by numeric ids, renaming the repository or someone else creating a repository with the same name does not let anyone assume them.

### 6.2 Environments

Create `dev` and `prod` under Settings → Environments:

| Environment | Deployment branches and tags | Required reviewers |
|---|---|---|
| `dev` | `main` only | None |
| `prod` | Tags `v*` only | Yourself (the maintainer). While there is only one maintainer, **do not** enable "Prevent self-review", or you will not be able to approve your own deployments |

### 6.3 Secrets and variables

**Put every environment-specific value in a secret.** The runner prints variables (vars) as step environment **before** masking applies, so in a public repository the account id or domains would be readable in the logs. lint forbids reading them from vars.

```bash
# Repository secrets
gh secret set AWS_ACCOUNT_ID -R $REPO --body "$ACCOUNT"
gh secret set MCPWIKI_DOMAINS -R $REPO < <(node -e 'process.stdout.write(JSON.stringify(require("./config/domains.local.json")))')   # optional
gh secret set MCPWIKI_ALARM_EMAIL -R $REPO --body ops@example.com                                                                  # optional (synth warns if prod has none)

# Environment secrets
gh secret set AWS_DEPLOY_ROLE_ARN --env dev  -R $REPO --body <DeployRoleArndev>
gh secret set AWS_DEPLOY_ROLE_ARN --env prod -R $REPO --body <DeployRoleArnprod>
openssl rand -hex 32 | gh secret set ARTIFACT_ENCRYPTION_KEY --env dev  -R $REPO   # key for the sealed cloud assembly (different per environment)
openssl rand -hex 32 | gh secret set ARTIFACT_ENCRYPTION_KEY --env prod -R $REPO

# Repository variables (non-secret values only)
gh variable set AWS_REGION -R $REPO --body "$REGION"
gh variable set DEPLOY_ENABLED -R $REPO --body true    # the Deploy workflow is skipped until this is set
```

Optional settings:

| Name | Kind | Purpose |
|---|---|---|
| `DEV_URL` | Secret | Target of the weekly OWASP ZAP baseline (the dev URL) |
| `ARTIFACT_ENCRYPTION_KEY` | Repository secret | Store the ZAP report encrypted |
| `ENABLE_AI_SECURITY_REVIEW=true` and `ANTHROPIC_API_KEY` | Variable and secret | AI security review on every PR |
| `CODE_SCANNING_ENABLED=true` | Variable | Send results to the Security tab (Code scanning); needs a public repository or paid GitHub Code Security |

### 6.4 Check that it works

Merge anything into `main` (a README fix is fine) and the Deploy workflow deploys dev:

- `build` job: tests, synth and sealing, with no credentials
- `deploy` job: assumes the role with OIDC, deploys the pre-synthesized assembly and runs the smoke test

In a public repository, open the **whole log** of the first deployment and check that no account id, host name, hosted zone id or user pool id appears in it.

## 7. Release to prod

```bash
git switch main && git pull --ff-only
git tag v0.1.0 && git push origin v0.1.0
```

1. The Deploy workflow waits for the `prod` approval (first approval). Once approved, `build` runs and writes the **infrastructure diff against the previous tag** to the job summary.
2. Read the diff, then approve `deploy` (second approval). If a release that should only update dependencies changes IAM, CloudFront, Cognito, WAF or similar resources, don't approve it.
3. The first time, create the prod admin the same way as in step 5 (`scripts/create-admin.sh prod ...`).

prod adds WAF, AWS Backup (daily, 35-day retention, vault lock), DynamoDB PITR, deletion protection and stack termination protection.

## 8. Protect the GitHub repository

| Setting | Where | What |
|---|---|---|
| Branch protection | Settings → Rules → Rulesets (`main`) | Require a PR (0 approvals is fine), required checks (CI `test`, both CodeQL jobs, the Security jobs), block force pushes and deletion |
| Tag protection | Rulesets (tag, `v*`) | Only admins may create, update or delete (prod deploys are triggered by tags) |
| PRs from forks | Settings → Actions → General | "Require approval for all external contributors"; Workflow permissions "Read repository contents" |
| Code scanning | Settings → Advanced Security | Code scanning, secret scanning with push protection, private vulnerability reporting |

In a private repository, code scanning, Dependency Review, secret scanning, rulesets and Environment required reviewers may not be available on your plan. The scanners still fail their jobs and keep reports as artifacts.

## 9. Operations

| Task | How |
|---|---|
| Add users, change roles, disable users | Admin → Users in the web UI |
| Update dev | Merge to `main` (automatic) |
| Update prod | Push a `v*` tag and approve twice (step 7) |
| Dependency updates | Dependabot PRs, with a 7-day cooldown, lockfile review and infrastructure diff. See [docs/security.en.md](security.en.md#compromised-dependencies-supply-chain) |
| Alarm recipient | Secret `MCPWIKI_ALARM_EMAIL` (locally `MCPWIKI_ALARM_EMAIL=... npm run deploy:prod`). Nothing arrives until you click the link in SNS's confirmation e-mail |
| Rotate the origin secret | Update the value of `OriginSecret` (Secrets Manager) in stack `MCPWiki-<env>`, then redeploy. Expect a few 403s during the cutover |
| Cost | At small scale dev costs a few USD a month and prod about 10–20 USD including WAF. Every resource carries `Project` / `Environment` / `Component` / `ManagedBy` tags; activate them under Billing → Cost allocation tags to group costs in Cost Explorer |
| Stacks CI doesn't deploy | After changing `MCPWiki-guard` or `MCPWiki-ci`, an administrator deploys them from their machine |

## 10. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `dist/ is missing: run "npm run build"` | Run `npm run build` before `npx cdk ...` (`npm run deploy:*` does it for you) |
| `githubOidcSubjectPrefix (...) belongs to <owner>/<repo>, not ...` | A fork still has the upstream value. Set your own in step 6.1 (use `""` until then) |
| CI's `Configure AWS credentials` fails with `Not authorized to perform sts:AssumeRoleWithWebIdentity` | The OIDC `sub` doesn't match the role's condition. Check that you ran the customization in step 6.1, that `githubOidcSubjectPrefix` equals the value from `gh api .../oidc/customization/sub`, and that the Environment matches the branch or tag (dev ↔ `main`, prod ↔ `v*`) |
| A dev deployment fails with `... is not authorized to perform: iam:PassRole` | A dev role tries to pass a role outside the boundary. Make sure `MCPWiki-guard` is up to date (`npx cdk deploy MCPWiki-guard`) |
| A dev deployment fails with `BootstrapVersion` or `SSM parameter /cdk-bootstrap/mwdev/version not found` | `node scripts/bootstrap-dev.mjs` hasn't been run, or is outdated. Right after re-bootstrapping, add `--no-previous-parameters` once: `npx cdk deploy ... --no-previous-parameters` |
| Deploy fails with `seal: ARTIFACT_ENCRYPTION_KEY must be set (>= 32 chars)` | Add the secret `ARTIFACT_ENCRYPTION_KEY` to the Environment (`dev` / `prod`) |
| The Deploy workflow is always skipped | The repository variable `DEPLOY_ENABLED=true` is not set |
| An account id or domain showed up in a public log | Check whether that value is in vars and move it to a secret. Delete the run in the Actions UI (or with `gh api -X DELETE repos/<owner>/<repo>/actions/runs/<id>`) |
| Alarm e-mails never arrive | The link in the SNS confirmation e-mail (`AWS Notification - Subscription Confirmation`) hasn't been clicked |

## 11. Tearing down

**dev** (its data is deleted too):

```bash
npx cdk destroy MCPWiki-dev MCPWiki-dev-edge
```

**prod** is deliberately hard to delete, to protect its data:

1. Turn off stack termination protection: `aws cloudformation update-termination-protection --no-enable-termination-protection --stack-name MCPWiki-prod --region <region>`
2. Run `npx cdk destroy MCPWiki-prod MCPWiki-prod-edge`. The DynamoDB table, user pool, S3 buckets and Backup vault are `RETAIN`, so they **stay**.
3. Export any data you need, then delete the retained resources by hand (turn off deletion protection on the DynamoDB table and the user pool first). The Backup vault is locked (minimum retention 7 days): once recovery points can be deleted, delete them first, then the vault.

Finally remove the CI roles and the guard rails: `npx cdk destroy MCPWiki-ci -c githubRepo=<owner>/<repo>` and `npx cdk destroy MCPWiki-guard`. If nothing else uses them, delete the CDK bootstrap stacks (`CDKToolkit`, `CDKToolkit-mcpwiki-dev`) in CloudFormation.
