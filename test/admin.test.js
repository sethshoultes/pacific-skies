import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAdmin } from '../server/admin.js';

test('isAdmin denies everyone when SKIES_ADMINS is unset -- no "first registered user" fallback', () => {
  const prev = process.env.SKIES_ADMINS;
  delete process.env.SKIES_ADMINS;
  try {
    assert.equal(isAdmin({ id: 1, username: 'whoever_registered_first' }), false);
    assert.equal(isAdmin({ id: 999, username: 'someone_else' }), false);
    assert.equal(isAdmin(null), false);
  } finally {
    if (prev === undefined) delete process.env.SKIES_ADMINS; else process.env.SKIES_ADMINS = prev;
  }
});

test('isAdmin only grants access to usernames listed in SKIES_ADMINS', () => {
  const prev = process.env.SKIES_ADMINS;
  process.env.SKIES_ADMINS = 'boss, deputy';
  try {
    assert.equal(isAdmin({ id: 2, username: 'boss' }), true);
    assert.equal(isAdmin({ id: 3, username: 'deputy' }), true);
    assert.equal(isAdmin({ id: 1, username: 'rando' }), false, 'not listed -> not admin, even for user id 1');
  } finally {
    if (prev === undefined) delete process.env.SKIES_ADMINS; else process.env.SKIES_ADMINS = prev;
  }
});
