// Fails if an alarm e-mail address leaks out of the SNS subscription endpoint in a synthesized assembly:
// as a logical id, construct path, output, tag or anything else (CloudFormation events print logical ids in
// public deploy logs). Run on an assembly synthesized with a probe address:
//   npx cdk synth -c alarmEmail=ci-probe+mcpwiki@example.invalid && node scripts/ci/check-email-exposure.mjs cdk.out ci-probe+mcpwiki@example.invalid
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, email] = process.argv.slice(2);
if (!dir || !email?.includes('@')) {
  console.error('usage: node scripts/ci/check-email-exposure.mjs <cdk.out> <probe e-mail>');
  process.exit(2);
}
// The address as written, and with punctuation dropped (how CDK turns it into construct / logical ids).
const forms = [email, email.replace(/[^A-Za-z0-9]/g, '')];
let endpoints = 0;
const leaks = [];

function walk(value, where) {
  if (typeof value === 'string') {
    // tree.json repeats each resource's properties; the subscription endpoint is allowed there too.
    if (value === email && where.endsWith('aws:cdk:cloudformation:props.endpoint')) return;
    for (const f of forms) if (value.toLowerCase().includes(f.toLowerCase())) leaks.push(`${where}: ${value.slice(0, 120)}`);
  } else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${where}[${i}]`));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) {
    walk(k, `${where} (key)`);
    walk(v, `${where}.${k}`);
  }
}

for (const f of readdirSync(dir).filter((f) => f.endsWith('.template.json') || f === 'manifest.json' || f === 'tree.json')) {
  const doc = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  if (f.endsWith('.template.json')) {
    for (const [id, r] of Object.entries(doc.Resources ?? {})) {
      // The one allowed place: the endpoint of an e-mail subscription.
      if (r.Type === 'AWS::SNS::Subscription' && r.Properties?.Protocol === 'email' && r.Properties.Endpoint === email) {
        endpoints++;
        walk({ ...r.Properties, Endpoint: undefined }, `${f} ${id}.Properties`);
        walk(id, `${f} logical id`);
        walk(r.Metadata ?? {}, `${f} ${id}.Metadata`);
      } else walk({ [id]: r }, `${f} Resources`);
    }
    walk({ ...doc, Resources: undefined }, f);
  } else walk(doc, f);
}

if (!endpoints) {
  console.error('check-email-exposure: no e-mail subscription with the probe address was synthesized (wrong address or context?)');
  process.exit(2);
}
if (leaks.length) {
  console.error(`check-email-exposure: the alarm address leaks outside the subscription endpoint (${leaks.length}):`);
  for (const l of leaks.slice(0, 20)) console.error(`  ${l}`);
  process.exit(1);
}
console.log(`check-email-exposure: ok (${endpoints} subscription endpoint(s), no other occurrence)`);
