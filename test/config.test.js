import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, connectionKey, normalizeConfig } from '../src/config.js';

test('the defaults: no login, an image a minute, French names', () => {
  const config = normalizeConfig({});
  assert.deepEqual(config, {
    url: '',
    validUrl: false,
    username: '',
    password: '',
    snapshotSeconds: 60,
    language: 'fr',
  });
  assert.equal(DEFAULT_CONFIG.username, '');
});

test('values outside the lists fall back to the defaults; an empty user means no login', () => {
  const config = normalizeConfig({
    url: ' 192.0.2.10 ',
    username: '  ',
    snapshot_interval: 'often',
    language: 'it',
  });
  assert.equal(config.url, '192.0.2.10');
  assert.equal(config.validUrl, true);
  assert.equal(config.username, '');
  assert.equal(config.snapshotSeconds, 60);
  assert.equal(config.language, 'fr');
  assert.equal(normalizeConfig({ snapshot_interval: '10' }).snapshotSeconds, 10);
});

test('a new password is a new connection, a new interval is not', () => {
  const base = normalizeConfig({ url: '192.0.2.10', password: 'a' });
  assert.notEqual(connectionKey(base), connectionKey({ ...base, password: 'b' }));
  assert.equal(connectionKey(base), connectionKey({ ...base, snapshotSeconds: 10 }));
});
