// Keeps environment-specific identifiers out of public Actions logs and job summaries.
//
// Workflow logs, job summaries and artifacts of a public repository are readable by anyone, so the
// AWS account id, hosted zone and host names (kept out of git) must not appear there either.
//
//   node scripts/ci/redact.mjs --mask          emit ::add-mask:: for every known value (run first in a job)
//   <cmd> 2>&1 | node scripts/ci/redact.mjs    copy stdin to stdout with known values and AWS ids replaced
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

// Identifiers created at deploy time (not known in advance).
const PATTERNS = [
  /\b\d{12}\b/g, // AWS account ids (also inside ARNs)
  /\b[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]{6,}\b/g, // Cognito user pool ids
  /\bd[a-z0-9]{8,16}\.cloudfront\.net\b/g, // CloudFront distribution domains
  /\b[a-z0-9]{10}\.execute-api\.[a-z0-9-]+\.amazonaws\.com\b/g, // API Gateway endpoints
  /\bZ[A-Z0-9]{8,32}\b/g, // Route 53 hosted zone ids
];

if (process.argv.includes('--mask')) {
  for (const v of values) console.log(`::add-mask::${v}`);
  console.log(`redact: registered ${values.size} value(s) for masking`);
  process.exit(0);
}

// Longest first so that "auth.<host>" is replaced before "<host>".
const literal = [...values].sort((a, b) => b.length - a.length);
const redactLine = (line) => {
  let out = line;
  for (const v of literal) out = out.split(v).join('***');
  for (const re of PATTERNS) out = out.replace(re, '***');
  return out;
};

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) process.stdout.write(redactLine(line) + '\n');
