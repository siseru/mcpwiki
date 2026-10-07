// Keeps environment-specific identifiers out of public Actions logs and job summaries.
//
// Workflow logs, job summaries and artifacts of a public repository are readable by anyone, so the
// AWS account id, hosted zone and host names (kept out of git) must not appear there either.
//
//   <cmd> 2>&1 | node scripts/ci/redact.mjs    copy stdin to stdout with known values and AWS ids replaced
// (Masks for the runner are registered by scripts/ci/mask.sh.)
//
// Known values come from AWS_ACCOUNT_ID, MCPWIKI_DOMAINS (the same variables the deploy uses) and REDACT_EXTRA.
import { createInterface } from 'node:readline';

const values = new Set();
const add = (v) => {
  if (typeof v === 'string' && v.trim().length >= 4) values.add(v.trim());
};
add(process.env.AWS_ACCOUNT_ID);
// Extra values / URLs (their host names are masked), comma-separated, e.g. REDACT_EXTRA=${{ vars.DEV_URL }}
for (const item of (process.env.REDACT_EXTRA ?? '').split(',')) {
  try {
    add(new URL(item.trim()).host);
  } catch {
    add(item);
  }
}
try {
  const d = JSON.parse(process.env.MCPWIKI_DOMAINS || 'null');
  if (d) {
    add(d.hostedZoneId);
    add(d.zoneName);
    for (const h of Object.values(d.hosts ?? {})) {
      add(h);
      add(`auth.${h}`);
    }
  }
} catch {
  console.error('redact: MCPWIKI_DOMAINS is not valid JSON; only generic patterns are applied');
}

// Identifiers created at deploy time (not known in advance). Each log line is split into tokens and every
// token is tested against fully anchored patterns (no partial matches inside unrelated words or URLs).
const TOKEN_PATTERNS = [
  /^\d{12}$/, // AWS account id
  /^[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]{6,}$/, // Cognito user pool id
  /^d[a-z0-9]{8,16}\.cloudfront\.net$/, // CloudFront distribution domain
  /^[a-z0-9]{10}\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/, // API Gateway endpoint
  /^Z[A-Z0-9]{8,32}$/, // Route 53 hosted zone id
];
const TOKEN = /[A-Za-z0-9_.-]+/g;

// Longest first so that "auth.<host>" is replaced before "<host>".
const literal = [...values].sort((a, b) => b.length - a.length);
const redactLine = (line) => {
  let out = line;
  for (const v of literal) out = out.split(v).join('***');
  // ARNs split on ":" and "/", so an account id inside an ARN is its own token.
  return out.replace(TOKEN, (tok) => (TOKEN_PATTERNS.some((re) => re.test(tok)) ? '***' : tok));
};

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) process.stdout.write(redactLine(line) + '\n');
