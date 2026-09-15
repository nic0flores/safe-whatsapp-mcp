import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const EXPECTED_BAILEYS_VERSION = '7.0.0-rc14';
const PATCH_MARKER = 'SAFE_WHATSAPP_MCP_PAIRING_REFRESH_PATCH_V1';
const root = process.cwd();
const baileysRoot = path.join(root, 'node_modules', 'baileys');

const packageJsonPath = path.join(baileysRoot, 'package.json');
const utilsPath = path.join(baileysRoot, 'lib', 'Utils', 'companion-reg-client-utils.js');
const socketPath = path.join(baileysRoot, 'lib', 'Socket', 'socket.js');
const recvPath = path.join(baileysRoot, 'lib', 'Socket', 'messages-recv.js');

const fail = (message) => {
  throw new Error(`[baileys-pairing-refresh] ${message}`);
};

const countOccurrences = (source, needle) => source.split(needle).length - 1;

const replaceExactlyOnce = (source, needle, replacement, label) => {
  const count = countOccurrences(source, needle);
  if (count !== 1) {
    fail(`${label}: expected exactly one upstream anchor, found ${count}. Refusing to patch an unknown Baileys build.`);
  }
  return source.replace(needle, replacement);
};

const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
if (packageJson.version !== EXPECTED_BAILEYS_VERSION) {
  fail(`expected baileys ${EXPECTED_BAILEYS_VERSION}, found ${packageJson.version ?? '<unknown>'}`);
}

let utils = await readFile(utilsPath, 'utf8');
if (!utils.includes(PATCH_MARKER)) {
  if (!utils.includes('export const buildPairingQRData')) {
    fail('companion-reg-client-utils.js does not match the expected rc14 surface');
  }

  const sourceMapMarker = '//# sourceMappingURL=companion-reg-client-utils.js.map';
  if (countOccurrences(utils, sourceMapMarker) !== 1) {
    fail('companion-reg-client-utils.js source-map anchor is missing or ambiguous');
  }

  const helperPatch = `
// ${PATCH_MARKER}
export const makePairingQRRenderer = (refs, render) => {
    let index = 0;
    let current;
    return {
        next() {
            const ref = refs[index];
            if (ref === undefined) {
                return false;
            }
            index += 1;
            current = ref;
            render(ref);
            return true;
        },
        refresh() {
            if (current === undefined) {
                return false;
            }
            render(current);
            return true;
        }
    };
};
const COMPANION_REG_REFRESH_CHILDREN = ['companion_reg_refresh', 'pair-device-rotate-qr'];
export const handleCompanionRegRefresh = (node, { creds, emitCredsUpdate, refreshQR, logger }) => {
    if (!COMPANION_REG_REFRESH_CHILDREN.some(tag => getBinaryNodeChild(node, tag))) {
        logger.warn({ node }, 'companion_reg_refresh carries neither expected child; ignoring');
        return 'ignored_malformed';
    }
    if (creds.me) {
        logger.debug({ id: node.attrs.id }, 'companion_reg_refresh on a registered session; keeping the adv secret');
        return 'ignored_registered';
    }
    creds.advSecretKey = randomBytes(32).toString('base64');
    emitCredsUpdate({ advSecretKey: creds.advSecretKey });
    logger.info({ id: node.attrs.id }, 'rotated the adv secret the server asked to retire; re-rendering the pairing QR');
    refreshQR();
    return 'rotated';
};
`;

  utils = `import { randomBytes } from 'crypto';\nimport { getBinaryNodeChild } from '../WABinary/index.js';\n${utils}`;
  utils = utils.replace(sourceMapMarker, `${helperPatch}\n${sourceMapMarker}`);
  await writeFile(utilsPath, utils, 'utf8');
}

let socket = await readFile(socketPath, 'utf8');
if (!socket.includes(PATCH_MARKER)) {
  const importAnchor = "import { WebSocketClient } from './Client/index.js';";
  socket = replaceExactlyOnce(
    socket,
    importAnchor,
    `import { handleCompanionRegRefresh, makePairingQRRenderer } from '../Utils/companion-reg-client-utils.js';\n${importAnchor}`,
    'socket import'
  );

  const qrStartToken = '// QR gen';
  const pairedToken = '// device paired for the first time';
  const qrStart = socket.indexOf(qrStartToken);
  const pairedStart = socket.indexOf(pairedToken, qrStart + qrStartToken.length);
  if (qrStart < 0 || pairedStart < 0 || pairedStart <= qrStart) {
    fail('socket.js QR pairing anchors are missing or out of order');
  }
  if (socket.indexOf(qrStartToken, qrStart + qrStartToken.length) !== -1) {
    fail('socket.js contains more than one QR generation anchor');
  }
  if (socket.indexOf(pairedToken, pairedStart + pairedToken.length) !== -1) {
    fail('socket.js contains more than one pair-success anchor');
  }

  const indentMatch = socket.slice(Math.max(0, qrStart - 16), qrStart).match(/(^|\n)([ \t]*)$/);
  const i = indentMatch?.[2] ?? '    ';
  const qrPatch = `${i}// ${PATCH_MARKER}\n${i}let refreshPairingQR;\n${i}// QR gen\n${i}ws.on('CB:iq,type:set,pair-device', async (stanza) => {\n${i}    const iq = {\n${i}        tag: 'iq',\n${i}        attrs: {\n${i}            to: S_WHATSAPP_NET,\n${i}            type: 'result',\n${i}            id: stanza.attrs.id\n${i}        }\n${i}    };\n${i}    await sendNode(iq);\n${i}    const pairDeviceNode = getBinaryNodeChild(stanza, 'pair-device');\n${i}    const refNodes = getBinaryNodeChildren(pairDeviceNode, 'ref');\n${i}    const noiseKeyB64 = Buffer.from(creds.noiseKey.public).toString('base64');\n${i}    const identityKeyB64 = Buffer.from(creds.signedIdentityKey.public).toString('base64');\n${i}    const renderer = makePairingQRRenderer(\n${i}        refNodes.map(refNode => refNode.content.toString('utf-8')),\n${i}        ref => ev.emit('connection.update', {\n${i}            qr: buildPairingQRData(ref, noiseKeyB64, identityKeyB64, creds.advSecretKey, browser)\n${i}        })\n${i}    );\n${i}    refreshPairingQR = () => void renderer.refresh();\n${i}    let qrMs = qrTimeout || 60000;\n${i}    const genPairQR = () => {\n${i}        if (!ws.isOpen) {\n${i}            return;\n${i}        }\n${i}        if (!renderer.next()) {\n${i}            void end(new Boom('QR refs attempts ended', { statusCode: DisconnectReason.timedOut }));\n${i}            return;\n${i}        }\n${i}        qrTimer = setTimeout(genPairQR, qrMs);\n${i}        qrMs = qrTimeout || 20000;\n${i}    };\n${i}    genPairQR();\n${i}});\n${i}ws.on('CB:notification,type:companion_reg_refresh', (node) => {\n${i}    handleCompanionRegRefresh(node, {\n${i}        creds,\n${i}        emitCredsUpdate: update => ev.emit('creds.update', update),\n${i}        refreshQR: () => refreshPairingQR?.(),\n${i}        logger\n${i}    });\n${i}});\n${i}`;

  socket = `${socket.slice(0, qrStart)}${qrPatch}${socket.slice(pairedStart)}`;
  await writeFile(socketPath, socket, 'utf8');
}

let recv = await readFile(recvPath, 'utf8');
if (!recv.includes(`${PATCH_MARKER}:pre-login-ack`)) {
  const before = 'buildAckStanza(node, errorCode, authState.creds.me.id)';
  const after = `buildAckStanza(node, errorCode, authState.creds.me?.id) /* ${PATCH_MARKER}:pre-login-ack */`;
  recv = replaceExactlyOnce(recv, before, after, 'messages-recv pre-login ACK');
  await writeFile(recvPath, recv, 'utf8');
}

const [patchedUtils, patchedSocket, patchedRecv] = await Promise.all([
  readFile(utilsPath, 'utf8'),
  readFile(socketPath, 'utf8'),
  readFile(recvPath, 'utf8')
]);

const requiredChecks = [
  [patchedUtils.includes(PATCH_MARKER), 'helper patch marker'],
  [patchedUtils.includes('handleCompanionRegRefresh'), 'refresh handler'],
  [patchedUtils.includes('makePairingQRRenderer'), 'QR renderer'],
  [patchedSocket.includes("CB:notification,type:companion_reg_refresh"), 'socket refresh listener'],
  [patchedSocket.includes('creds.advSecretKey, browser'), 'per-render adv secret'],
  [patchedRecv.includes('authState.creds.me?.id'), 'pre-login ACK guard']
];
for (const [ok, label] of requiredChecks) {
  if (!ok) {
    fail(`post-patch verification failed: ${label}`);
  }
}

process.stderr.write(`[baileys-pairing-refresh] patched baileys ${EXPECTED_BAILEYS_VERSION} with upstream PR #2765 + pre-login ACK fix from PR #2749\n`);
