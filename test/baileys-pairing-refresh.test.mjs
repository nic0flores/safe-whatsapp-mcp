import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const PATCH_MARKER = 'SAFE_WHATSAPP_MCP_PAIRING_REFRESH_PATCH_V1';
const root = process.cwd();
const baileysRoot = path.join(root, 'node_modules', 'baileys');
const packageJsonPath = path.join(baileysRoot, 'package.json');
const utilsPath = path.join(baileysRoot, 'lib', 'Utils', 'companion-reg-client-utils.js');
const socketPath = path.join(baileysRoot, 'lib', 'Socket', 'socket.js');
const recvPath = path.join(baileysRoot, 'lib', 'Socket', 'messages-recv.js');

const importPatchedHelpers = async () => import('../node_modules/baileys/lib/Utils/companion-reg-client-utils.js');

const logger = {
  info() {},
  warn() {},
  debug() {}
};

test('pairing compatibility patch is pinned to Baileys rc14 and idempotent', async () => {
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  assert.equal(packageJson.version, '7.0.0-rc14');

  execFileSync(process.execPath, ['scripts/apply-baileys-pairing-refresh-patch.mjs'], {
    cwd: root,
    stdio: 'pipe'
  });

  const [utils, socket, recv] = await Promise.all([
    readFile(utilsPath, 'utf8'),
    readFile(socketPath, 'utf8'),
    readFile(recvPath, 'utf8')
  ]);

  assert.match(utils, new RegExp(PATCH_MARKER));
  assert.match(utils, /handleCompanionRegRefresh/);
  assert.match(utils, /makePairingQRRenderer/);
  assert.match(socket, /CB:notification,type:companion_reg_refresh/);
  assert.match(socket, /creds\.advSecretKey, browser/);
  assert.doesNotMatch(socket, /const advB64 = creds\.advSecretKey/);
  assert.match(recv, /buildAckStanza\(node, errorCode, authState\.creds\.me\?\.id\)/);
  assert.doesNotMatch(recv, /buildAckStanza\(node, errorCode, authState\.creds\.me\.id\)/);
});

test('QR refresh re-renders the current ref without consuming the next server ref', async () => {
  const { makePairingQRRenderer } = await importPatchedHelpers();
  const rendered = [];
  const renderer = makePairingQRRenderer(['ref-1', 'ref-2'], ref => rendered.push(ref));

  assert.equal(renderer.refresh(), false);
  assert.equal(renderer.next(), true);
  assert.deepEqual(rendered, ['ref-1']);

  for (let i = 0; i < 50; i += 1) {
    assert.equal(renderer.refresh(), true);
  }
  assert.equal(rendered.length, 51);
  assert.ok(rendered.every(ref => ref === 'ref-1'));

  assert.equal(renderer.next(), true);
  assert.equal(rendered.at(-1), 'ref-2');
  assert.equal(renderer.next(), false);
});

test('companion_reg_refresh rotates a fresh 32-byte ADV secret and requests a QR re-render', async () => {
  const { handleCompanionRegRefresh } = await importPatchedHelpers();
  const oldSecret = Buffer.alloc(32, 7).toString('base64');
  const creds = { advSecretKey: oldSecret };
  const updates = [];
  let refreshCount = 0;

  const outcome = handleCompanionRegRefresh(
    {
      tag: 'notification',
      attrs: { id: 'refresh-1', type: 'companion_reg_refresh', from: 's.whatsapp.net' },
      content: [{ tag: 'companion_reg_refresh', attrs: {} }]
    },
    {
      creds,
      emitCredsUpdate: update => updates.push(update),
      refreshQR: () => { refreshCount += 1; },
      logger
    }
  );

  assert.equal(outcome, 'rotated');
  assert.notEqual(creds.advSecretKey, oldSecret);
  assert.equal(Buffer.from(creds.advSecretKey, 'base64').length, 32);
  assert.deepEqual(updates, [{ advSecretKey: creds.advSecretKey }]);
  assert.equal(refreshCount, 1);
});

test('companion_reg_refresh ignores malformed notifications and registered sessions', async () => {
  const { handleCompanionRegRefresh } = await importPatchedHelpers();

  const malformedCreds = { advSecretKey: Buffer.alloc(32, 1).toString('base64') };
  const malformedOriginal = malformedCreds.advSecretKey;
  let malformedRefreshes = 0;
  const malformedOutcome = handleCompanionRegRefresh(
    {
      tag: 'notification',
      attrs: { id: 'bad-refresh', type: 'companion_reg_refresh', from: 's.whatsapp.net' },
      content: []
    },
    {
      creds: malformedCreds,
      emitCredsUpdate() { assert.fail('malformed refresh must not emit credential updates'); },
      refreshQR: () => { malformedRefreshes += 1; },
      logger
    }
  );
  assert.equal(malformedOutcome, 'ignored_malformed');
  assert.equal(malformedCreds.advSecretKey, malformedOriginal);
  assert.equal(malformedRefreshes, 0);

  const registeredCreds = {
    advSecretKey: Buffer.alloc(32, 2).toString('base64'),
    me: { id: '56911111111@s.whatsapp.net' }
  };
  const registeredOriginal = registeredCreds.advSecretKey;
  let registeredRefreshes = 0;
  const registeredOutcome = handleCompanionRegRefresh(
    {
      tag: 'notification',
      attrs: { id: 'registered-refresh', type: 'companion_reg_refresh', from: 's.whatsapp.net' },
      content: [{ tag: 'pair-device-rotate-qr', attrs: {} }]
    },
    {
      creds: registeredCreds,
      emitCredsUpdate() { assert.fail('registered session must keep its ADV secret'); },
      refreshQR: () => { registeredRefreshes += 1; },
      logger
    }
  );
  assert.equal(registeredOutcome, 'ignored_registered');
  assert.equal(registeredCreds.advSecretKey, registeredOriginal);
  assert.equal(registeredRefreshes, 0);
});
