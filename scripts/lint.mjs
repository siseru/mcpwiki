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

// Runtime dependencies are restricted to the approved set.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const allowed = new Set(['marked', 'dompurify']);
for (const d of Object.keys(pkg.dependencies ?? {})) if (!allowed.has(d)) violations.push(`package.json: runtime dependency "${d}" is not approved`);

if (violations.length) {
  console.error(`lint: ${violations.length} violation(s)\n` + violations.join('\n'));
  process.exit(1);
}
console.log('lint: ok');
