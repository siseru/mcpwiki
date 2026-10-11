// Checks MCPWiki's request logs against published indicators of compromise (IP addresses, User-Agent
// substrings) and summarizes who is probing the API. Read-only (CloudWatch Logs Insights via the AWS CLI).
//
//   node scripts/ioc-check.mjs --env prod --since 2026-09-01 --ips 20.210.128.125,3.112.252.14 --ua sqlmap,python-requests
//   node scripts/ioc-check.mjs --env dev --ips-file iocs.txt          # one IP per line, "#" comments, [.] defanging ok
//
// Exit code: 0 = no indicator matched, 1 = at least one match (investigate), 2 = usage / AWS error.
// Note: User-Agent is logged from 2026-10 (this script's release) on; older entries can only match by IP.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') ? 'true' : all[i + 1]]] : acc), []),
);
const fail = (msg) => {
  console.error(`ioc-check: ${msg}`);
  process.exit(2);
};
const env = args.env;
if (env !== 'dev' && env !== 'prod') fail('--env dev|prod is required');
const region = process.env.MCPWIKI_REGION || JSON.parse(readFileSync('cdk.json', 'utf8')).context?.region || 'us-west-2';
const since = args.since ? Date.parse(args.since) : Date.now() - 90 * 86_400_000;
if (Number.isNaN(since)) fail('--since must be a date (YYYY-MM-DD)');

const refang = (s) => s.replace(/\[\.\]/g, '.').trim();
const ips = [
  ...(args.ips ? args.ips.split(',') : []),
  ...(args['ips-file'] ? readFileSync(args['ips-file'], 'utf8').split('\n').map((l) => l.replace(/#.*/, '')) : []),
]
  .map(refang)
  .filter(Boolean);
const uas = (args.ua ? args.ua.split(',') : []).map((s) => s.trim()).filter(Boolean);
// Values end up inside a Logs Insights query: allow only what IPs / UA tokens need.
for (const ip of ips) if (!/^[0-9a-fA-F:.]{3,45}$/.test(ip)) fail(`not an IP address: ${ip}`);
for (const ua of uas) if (!/^[A-Za-z0-9 ._\/()+;:-]{2,80}$/.test(ua)) fail(`unsupported characters in --ua value: ${ua}`);

const aws = (...a) => JSON.parse(execFileSync('aws', [...a, '--region', region, '--output', 'json'], { encoding: 'utf8' }));
let logGroup;
try {
  logGroup = aws('cloudformation', 'describe-stack-resource', '--stack-name', `MCPWiki-${env}`, '--logical-resource-id', 'ApiFnLogsADB874AE')
    .StackResourceDetail.PhysicalResourceId;
} catch (e) {
  fail(`cannot find the function log group of MCPWiki-${env} (${e.message.split('\n')[0]})`);
}

function query(q) {
  const { queryId } = aws('logs', 'start-query', '--log-group-name', logGroup, '--start-time', String(Math.floor(since / 1000)), '--end-time', String(Math.floor(Date.now() / 1000)), '--query-string', q);
  for (let i = 0; i < 120; i++) {
    const r = aws('logs', 'get-query-results', '--query-id', queryId);
    if (r.status === 'Complete') return { rows: r.results.map((row) => Object.fromEntries(row.map((f) => [f.field, f.value]))), scanned: r.statistics.recordsScanned };
    if (r.status === 'Failed' || r.status === 'Cancelled') fail(`query ${r.status}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000); // portable sleep
  }
  fail('query timed out');
}

console.log(`MCPWiki ${env}: ${logGroup} since ${new Date(since).toISOString().slice(0, 10)}`);
const total = query("filter msg = 'request' | stats count(*) as requests, count_distinct(ip) as ips, min(@timestamp) as first, max(@timestamp) as last");
const t = total.rows[0] ?? {};
console.log(`requests: ${t.requests ?? 0} from ${t.ips ?? 0} addresses (${t.first ?? '-'} .. ${t.last ?? '-'})`);

let matches = 0;
const conds = [...(ips.length ? [`ip in [${ips.map((ip) => `"${ip}"`).join(',')}]`] : []), ...uas.map((ua) => `ua like "${ua}"`)];
if (conds.length) {
  const hit = query(`filter msg = 'request' and (${conds.join(' or ')}) | stats count(*) as n, min(@timestamp) as first, max(@timestamp) as last by ip, ua | sort n desc | limit 50`);
  matches = hit.rows.length;
  console.log(`\nindicator matches (${ips.length} IPs, ${uas.length} User-Agent patterns): ${matches || 'none'}`);
  for (const r of hit.rows) console.log(`  ${r.n.padStart(6)}  ${r.ip ?? '-'}  ${r.ua ?? '-'}  ${r.first} .. ${r.last}`);
} else {
  console.log('\n(no --ips / --ua given: only the summaries below)');
}

const probes = query(
  "filter msg = 'request' and status >= 400 | stats count(*) as n, count_distinct(path) as paths, sum(status = 401) as s401, sum(status = 403) as s403, sum(status = 404) as s404 by ip, ispresent(user) as signedIn | sort n desc | limit 10",
);
console.log('\ntop sources of 4xx responses:');
for (const r of probes.rows) console.log(`  ${r.n.padStart(6)}  ${(r.ip ?? '-').padEnd(40)} signed-in=${r.signedIn === '1'} paths=${r.paths} 401=${r.s401} 403=${r.s403} 404=${r.s404}`);
const paths = query("filter msg = 'request' and status >= 400 and not ispresent(user) | stats count(*) as n by method, path | sort n desc | limit 10");
console.log('\nmost probed paths (not signed in):');
for (const r of paths.rows) console.log(`  ${r.n.padStart(6)}  ${r.method} ${r.path}`);
const audit = query("filter msg = 'audit' and action in ['user.invite','user.update','export-all','import','settings','bulk'] | sort @timestamp desc | limit 20 | fields @timestamp, action, actor, via, detail");
console.log('\nrecent security-relevant admin actions (audit):');
for (const r of audit.rows) console.log(`  ${r['@timestamp']}  ${r.action}  by ${r.actor} (${r.via})  ${r.detail ?? ''}`);
if (!audit.rows.length) console.log('  none (audit events are in the function log from 2026-10 on; older ones: Admin -> Audit log)');

process.exit(matches ? 1 : 0);
