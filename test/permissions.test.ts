import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canChangePermissions, canCreate, canRead, canWrite, roleFromGroups, scopesValid } from '../src/shared/permissions.js';
import { READ_SCOPES, ROLES, WRITE_SCOPES } from '../src/shared/types.js';

test('roleFromGroups picks highest', () => {
  assert.equal(roleFromGroups(['viewer', 'editor']), 'editor');
  assert.equal(roleFromGroups(['admin', 'viewer']), 'admin');
  assert.equal(roleFromGroups(['other']), null);
  assert.equal(roleFromGroups(undefined), null);
});

test('full permission matrix', () => {
  for (const role of ROLES) for (const isOwner of [true, false]) for (const readScope of READ_SCOPES) for (const writeScope of WRITE_SCOPES) for (const deleted of [false, true]) {
    if (!scopesValid(readScope, writeScope)) continue;
    const p = { sub: isOwner ? 'o' : 'x', role };
    const a = { owner: 'o', readScope, writeScope, deleted };
    const expRead = role === 'admin' || (!deleted && (readScope === 'all' || (readScope === 'owner' && isOwner)));
    const expWrite = role === 'admin' || (role === 'editor' && expRead && (writeScope === 'all' || (writeScope === 'owner' && isOwner)));
    const label = JSON.stringify({ role, isOwner, readScope, writeScope, deleted });
    assert.equal(canRead(p, a), expRead, `read ${label}`);
    assert.equal(canWrite(p, a), expWrite, `write ${label}`);
    if (expWrite) assert.ok(expRead, 'write implies read');
    assert.equal(canChangePermissions(p, a), role === 'admin' || (role === 'editor' && isOwner && !deleted), `perm ${label}`);
  }
  assert.equal(canCreate({ sub: 'x', role: 'viewer' }), false);
  assert.equal(canCreate({ sub: 'x', role: 'editor' }), true);
});

test('scope combinations', () => {
  assert.equal(scopesValid('admin', 'owner'), false);
  assert.equal(scopesValid('owner', 'all'), false);
  assert.equal(scopesValid('owner', 'admin'), true);
  assert.equal(scopesValid('all', 'all'), true);
  assert.equal(scopesValid('admin', 'none'), true);
});
