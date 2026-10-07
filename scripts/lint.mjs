// Repository policy checks (deterministic; non-zero exit on violation).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const files = (dir) => statSync(dir).isFile() ? [dir] :
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
const violations = [];
const check = (glob, re, why) => {
  for (const f of files(join(root, glob)).filter((f) => f.endsWith('.ts'))) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (re.test(line) && !/lint-allow/.test(line)) violations.push(`${relative(root, f)}:${i + 1}: ${why}\n    ${line.trim()}`);
    });
  }
};

// XSS: the web app must never write HTML strings into the DOM.
check('src/web', /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|\beval\(|new Function\(/, 'raw HTML / dynamic code in web app');
// Secrets / tokens must not be persisted in localStorage.
check('src/web', /localStorage/, 'use sessionStorage for tokens');
// MCP and CLI must not offer deletion.
check('src/backend/mcp.ts', /name:\s*'[^']*(delete|remove|destroy)[^']*'/, 'MCP must not expose a delete tool');
check('src/cli', /method:\s*'DELETE'|'DELETE'/, 'CLI must not call DELETE');
// No logging of tokens or request bodies in the backend.
check('src/backend', /console\.(log|error)\(.*(authorization|accessToken|req\.body|\.body\))/i, 'do not log credentials or bodies');

// GitHub Actions supply chain: actions pinned to full commit SHAs, explicit permissions, and OIDC token
// minting confined to the deploy job (and Scorecard's result publishing).
const wfDir = join(root, '.github/workflows');
for (const f of readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f))) {
  const text = readFileSync(join(wfDir, f), 'utf8');
  text.split('\n').forEach((line, i) => {
    const m = /^\s*-?\s*uses:\s*([^\s#]+)/.exec(line);
    if (m && !m[1].startsWith('./') && !/@[0-9a-f]{40}$/.test(m[1])) violations.push(`.github/workflows/${f}:${i + 1}: action not pinned to a commit SHA: ${m[1]}`);
    if (/id-token:\s*write/.test(line) && !['deploy.yml', 'scorecard.yml'].includes(f)) violations.push(`.github/workflows/${f}:${i + 1}: id-token: write outside the deploy workflow`);
    if (/pull_request_target/.test(line)) violations.push(`.github/workflows/${f}:${i + 1}: pull_request_target is not allowed`);
  });
  if (!/^permissions:/m.test(text)) violations.push(`.github/workflows/${f}: missing top-level permissions`);
  if (f === 'deploy.yml' && /^permissions:[\s\S]*?^\S/m.exec(text)?.[0].includes('id-token')) violations.push(`.github/workflows/${f}: id-token must be granted per job, not workflow-wide`);
}

// Runtime dependencies are restricted to the approved set.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const allowed = new Set(['marked', 'dompurify']);
for (const d of Object.keys(pkg.dependencies ?? {})) if (!allowed.has(d)) violations.push(`package.json: runtime dependency "${d}" is not approved`);

if (violations.length) {
  console.error(`lint: ${violations.length} violation(s)\n` + violations.join('\n'));
  process.exit(1);
}
console.log('lint: ok');
