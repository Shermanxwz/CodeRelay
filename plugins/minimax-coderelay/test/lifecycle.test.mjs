import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { start } from '../miniapp/node/server.mjs';

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('real Node lifecycle binds the assigned port, serves page/API and closes without init-time Agent calls', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'coderelay-lifecycle-'));
  const controller = new AbortController();
  const port = await unusedPort();
  let agentCalls = 0;
  const lifecycle = await start({
    pluginId: 'minimax-coderelay',
    pluginRoot: fileURLToPath(new URL('../', import.meta.url)),
    dataDir: directory,
    listen: { host: '127.0.0.1', port },
    signal: controller.signal,
    logger: { info() {}, error() {} },
    agent: {
      run() {
        agentCalls++;
        throw new Error('must not execute');
      },
    },
  });
  t.after(async () => {
    await lifecycle.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal(agentCalls, 0);
  const page = await fetch(`http://127.0.0.1:${port}/dashboard`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /绑定当前项目/);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
  const state = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
  assert.equal(state.connection, null);
  assert.equal(state.enabled, false);
  assert.equal(agentCalls, 0);
  const missing = await fetch(`http://127.0.0.1:${port}/not-a-file`);
  assert.equal(missing.status, 404);
  const invalid = await fetch(`http://127.0.0.1:${port}/api/connect`, {
    method: 'POST',
    body: '{}',
  });
  assert.equal(invalid.status, 415);
  const stopping = lifecycle.dispose();
  assert.equal(
    lifecycle.dispose(),
    stopping,
    'Host and lifecycle callers share shutdown completion',
  );
  await stopping;
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/status`));
});

test('the complete installable package starts from an isolated directory without npm install or repository dependencies', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'coderelay-install-'));
  const packageRoot = join(directory, 'plugins', 'minimax-coderelay');
  let lifecycle;
  await cp(fileURLToPath(new URL('../', import.meta.url)), packageRoot, { recursive: true });
  t.after(async () => {
    await lifecycle?.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  const plugin = JSON.parse(
    await readFile(join(packageRoot, '.minimax-plugin', 'plugin.json'), 'utf8'),
  );
  const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(plugin.name, 'minimax-coderelay');
  assert.deepEqual(plugin.apps, []);
  assert.deepEqual(plugin.mcpServers, []);
  assert.deepEqual(plugin.skills, []);
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.optionalDependencies, undefined);
  assert.equal(pkg.mcode.schemaVersion, 2);
  const mini = JSON.parse(await readFile(join(packageRoot, pkg.mcode.miniApp), 'utf8'));
  assert.equal(mini.schemaVersion, 1);
  assert.equal(mini.runtime.kind, 'process');
  assert.equal(mini.runtime.lifecycle, 'on-demand');
  assert.deepEqual(mini.agentAccess, ['session.run']);
  assert.deepEqual(mini.mcpEndpoints, []);
  assert.equal(mini.surface.path, '/dashboard');
  assert.equal(mini.engines.mcode, '>=3.1.6');
  for (const path of [...mini.artifacts.client, ...mini.artifacts.node])
    assert.equal((await stat(join(packageRoot, path))).isDirectory(), true);
  assert.equal((await stat(join(packageRoot, plugin.icon))).isFile(), true);
  const entry = await import(pathToFileURL(join(packageRoot, mini.runtime.entry)).href);
  const controller = new AbortController();
  const port = await unusedPort();
  lifecycle = await entry.start({
    pluginId: plugin.name,
    pluginRoot: packageRoot,
    dataDir: join(directory, 'host-data'),
    listen: { host: '127.0.0.1', port },
    signal: controller.signal,
    logger: { info() {}, error() {} },
  });
  for (const path of ['/dashboard', '/app.js', '/style.css', '/api/status']) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    assert.equal(response.status, 200, `isolated package serves ${path}`);
  }
});
