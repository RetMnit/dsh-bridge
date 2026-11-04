import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fakeConfig } from './fixtures.mjs';
import { connect } from '../lib/client.mjs';

// A pipe that answers like the bundle does, so the client runs without DSH.
function fakeBridge(pipe, token, reply) {
  const server = net.createServer(socket => {
    socket.setEncoding('utf8'); let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk; const cut = buffer.indexOf('\n'); if (cut < 0) return;
      const request = JSON.parse(buffer.slice(0, cut));
      const body = request.token !== token ? { error: { message: 'Unauthorized' } } : { result: reply(request.method, request.params) };
      socket.end(JSON.stringify({ id: request.id, ...body }) + '\n');
    });
  });
  return new Promise(resolve => server.listen(pipe, () => resolve(server)));
}

test('the client talks to a running Host and refuses one on another protocol', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-client-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settings = fakeConfig(root);
  const pipe = '\\\\.\\pipe\\dsh-bridge-client-test-' + randomUUID();
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ ...settings, pipes: { headless: pipe, desktop: pipe + '-missing' } }));
  let protocolVersion = 2;
  const server = await fakeBridge(pipe, settings.token, (method, params) => method === 'doctor' ? { protocolVersion } : { method, client: params.client });
  t.after(() => server.close());
  const dsh = connect({ state: root });
  assert.deepEqual(await dsh.call('headless', 'list', { client: 'alpha' }), { method: 'list', client: 'alpha' });
  const doctor = await dsh.doctor();
  assert.equal(doctor.modes.headless.protocolVersion, 2);
  assert.equal(doctor.modes.desktop.connected, false, 'doctor starts nothing');
  protocolVersion = 1;
  await assert.rejects(dsh.call('headless', 'list', { client: 'alpha' }), { code: 'dsh/protocol' });
  // Asking without starting checks the Host too, before the first call of a fresh client.
  await assert.rejects(connect({ state: root }).call('headless', 'events', { client: 'alpha' }, { start: false }), { code: 'dsh/protocol' });
  protocolVersion = 2;
  assert.deepEqual(await connect({ state: root }).call('headless', 'events', { client: 'alpha' }, { start: false }), { method: 'events', client: 'alpha' });
  await assert.rejects(connect({ state: root }).call('desktop', 'events', { client: 'alpha' }, { start: false }), { code: 'ENOENT' }, 'and never starts one');
  await assert.rejects(() => Promise.resolve().then(() => connect({ state: path.join(root, 'nowhere') })), { code: 'dsh/not-installed' });
});
