# Extensions

English | [日本語](extensions.md)

An extension is a UI built in another repository and deployed as another AWS stack. MCPWiki serves its bundle (JavaScript) from the wiki's own origin and lets it draw below articles and on a page of its own.

- **Off by default.** Without configuration, the synthesized templates and `config.json` are byte-identical to a wiki without this feature (checked by `test/extensions.test.ts`).
- Extension code runs in the wiki's origin **with the signed-in user's privileges (admins included)**. The browser only runs a bundle whose hash (SRI) matches the one in this wiki's configuration. See [docs/security.en.md](security.en.md#extensions).

## Contract (version 1)

The extension and the wiki agree on three things only. Extensions never import the wiki's internal modules.

1. The configuration shape (see "Configuration")
2. The host API (see "Host API")
3. The contract version. The versions this wiki supports are `EXTENSION_CONTRACTS` in `src/shared/types.ts`. The version changes only for breaking changes

## Configuration

A list of extensions per environment. Like the hosted-zone settings, it stays out of git.

| Where | Used for |
|---|---|
| `config/extensions.local.json` | Deploying from your machine (git-ignored; copy `config/extensions.example.json`) |
| Secret `MCPWIKI_EXTENSIONS` | CI (one line of JSON). Lint forbids vars, which appear in public logs |
| `-c extensions='<json>'` | One-off overrides |

```json
{
  "dev": [
    {
      "id": "persona-chat",
      "contract": 1,
      "bucketRegionalDomainName": "personachat-dev-bundles-example.s3.us-west-2.amazonaws.com",
      "script": "persona-chat-3f2a9c1e.js",
      "integrity": "sha384-<base64>",
      "connectSrc": ["wss://abcdefghij.execute-api.us-west-2.amazonaws.com"]
    }
  ],
  "prod": []
}
```

| Field | Meaning and constraints |
|---|---|
| `id` | Path segment of `/ext/<id>/` and `/apps/<id>/`. `^[a-z][a-z0-9-]{1,30}$`, unique |
| `contract` | Contract version the bundle was built for (one the wiki supports) |
| `bucketRegionalDomainName` | Regional domain of the extension's bucket (`<bucket>.s3.<stack region>.amazonaws.com`). Bundles live under `ext/<id>/` in that bucket |
| `script` | Bundle file name. Put a content hash into the name (it is cached for a year) |
| `integrity` | SRI of the bundle (`sha384-…` or `sha512-…`): `openssl dgst -sha384 -binary <file> \| openssl base64 -A` |
| `connectSrc` | Endpoints the bundle connects to (added to the CSP `connect-src`). `https://` or `wss://` host names only: no paths, ports, wildcards or IP addresses. At most 4 |

Values are validated at synthesis and rejected (not escaped) when they don't fit.

## What the wiki adds

With at least one extension, three things change:

| Where | Change |
|---|---|
| CloudFront | A `/ext/<id>/*` behavior that reads the extension's bucket through OAC, GET and HEAD only, with the wiki's security headers |
| CSP | `connectSrc` is appended to `connect-src`. `script-src 'self'` is unchanged |
| `config.json` | `extensions: [{ id, contract, src, integrity }]`. The bucket and endpoints are not sent to the browser |

The extension's stack owns the bucket policy. Grant read access to `ext/<id>/*` to this wiki's distribution ARN only:

```json
{
  "Effect": "Allow",
  "Principal": { "Service": "cloudfront.amazonaws.com" },
  "Action": "s3:GetObject",
  "Resource": "arn:aws:s3:::<bucket>/ext/<id>/*",
  "Condition": { "StringEquals": { "AWS:SourceArn": "arn:aws:cloudfront::<account>:distribution/<distribution-id>" } }
}
```

No CloudFormation reference links the two stacks; each side receives the other's values as configuration, so permissions never form a cycle.

## Host API

A bundle calls `register` once, when it is loaded:

```js
globalThis.mcpwikiHost.register({
  id: 'persona-chat',          // same as the configured id
  contract: 1,                 // same as the configured contract
  title: 'Talk to NPCs',       // sidebar link text (optional, up to 40 characters)
  articleSlot(ctx, el) { },    // draw into the slot below an article (optional)
  page(ctx, el, subpath) { },  // the /apps/<id>/... page (optional); subpath is "/" or e.g. "/npc/ricardo"
});
```

A registration whose `id` or `contract` differs from the configuration is refused, and so is any second registration.

`ctx`:

| Field | Meaning |
|---|---|
| `contract` | Contract version |
| `me` | `{ username, role }` |
| `article` | Only on article pages: `{ id, type, title, tags, extra, canEdit, ownerName }`. Old versions get no slot |
| `getAccessToken()` | The user's Cognito access token (refreshed when close to expiry), or `null` when signed out. **Send it to the extension's own API and to this wiki's API only** |
| `navigate(path)` | In-app navigation |
| `signal` | An `AbortSignal` aborted when the user leaves the view. Close sockets and timers with it |

**Where extensions draw, and failures**

- Below each article, every extension gets a `<section class="ext-slot" data-ext="<id>">`. An empty slot is not shown.
- In these cases the extension's slot shows a short notice. Only admins see it; everyone else sees nothing. On `/apps/<id>/` everyone sees it. The wiki keeps working in every case.
  - The bundle cannot be loaded (including an integrity mismatch)
  - `register` is not called within 15 seconds
  - The contract version doesn't match
  - `articleSlot` or `page` throws
- The sidebar lists `/apps/<id>/` under an "拡張" (Extensions) heading.

**Rules for extension code** (it runs in the wiki's origin)

- Never put HTML strings into the DOM (`innerHTML` and the like); build it with `textContent`.
- Never store tokens (neither `localStorage` nor `sessionStorage`) or log them.
- Don't depend on `config.json` or on other extensions.

## Deploying and removing

**Adding an extension**
1. Deploy the extension's stack. It creates the bundle and the bucket policy.
2. Add the extension's entry to this wiki's configuration (`MCPWIKI_EXTENSIONS`).
3. Redeploy this wiki. dev updates on merge to `main`; prod updates on a tag with two approvals.

**Releasing a new version of an extension**
1. Upload the new bundle under a new file name.
2. Update `script` and `integrity` in the configuration and redeploy this wiki.

Only the versions this wiki approved run.

**Removing an extension**
1. Delete its entry from the configuration.
2. Redeploy this wiki.
3. Delete the extension's stack.

With every extension removed, the templates and `config.json` are back to exactly what they were without this feature.
