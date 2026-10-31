import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initConfig, loadConfig, normalizePublicUrl } from '../src/config.js';

test('private initialization is explicit and cannot overwrite credentials', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coderelay-config-'));
  try {
    const first = initConfig({ dataDir: directory, publicUrl: 'https://relay.example.com' });
    assert.match(first.adminToken, /^cr_admin_/);
    assert.equal(loadConfig(directory).adminToken, first.adminToken);
    assert.throws(() => initConfig({ dataDir: directory }), /not overwritten/);
    assert.equal(loadConfig(directory).adminToken, first.adminToken);
    assert.equal(
      JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8')).publicUrl,
      'https://relay.example.com',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('production origins reject plaintext, credentials, subpaths, and confusing URLs', () => {
  for (const value of [
    'http://example.com',
    'https://user:secret@example.com',
    'https://example.com/path',
    'https://example.com?token=x',
    'https://example.com#fragment',
    ' https://example.com',
    'https:\\example.com',
  ])
    assert.throws(() => normalizePublicUrl(value));
  assert.equal(normalizePublicUrl('https://relay.example.com/'), 'https://relay.example.com');
  assert.equal(normalizePublicUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
});
test('public binds require an HTTPS advertised origin', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coderelay-bind-'));
  try {
    assert.throws(() => initConfig({ dataDir: directory, host: '0.0.0.0' }), /HTTPS/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test(
  'insecure POSIX config permissions are rejected',
  { skip: process.platform === 'win32' },
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'coderelay-mode-'));
    try {
      initConfig({ dataDir: directory });
      chmodSync(join(directory, 'config.json'), 0o644);
      assert.throws(() => loadConfig(directory), /0600/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
test(
  'private configuration cannot be loaded through a replaceable state directory',
  { skip: process.platform === 'win32' },
  () => {
    const parent = mkdtempSync(join(tmpdir(), 'coderelay-dir-'));
    const directory = join(parent, 'state');
    try {
      initConfig({ dataDir: directory });
      chmodSync(directory, 0o777);
      assert.throws(() => loadConfig(directory), /0700/);
      chmodSync(directory, 0o700);
      symlinkSync(directory, join(parent, 'alias'), 'dir');
      assert.throws(() => loadConfig(join(parent, 'alias')), /symbolic link/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  },
);
