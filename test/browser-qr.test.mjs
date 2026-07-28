import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import QRCode from "qrcode";
import { BrowserQrDisplay } from "../dist/qr/browserQr.js";
import { browserLaunchCommand } from "../dist/qr/openBrowser.js";

const PAYLOAD_A = "synthetic-browser-pairing-payload-a";
const PAYLOAD_B = "synthetic-browser-pairing-payload-b";
const PNG_OPTIONS = {
  type: "png",
  errorCorrectionLevel: "low",
  margin: 4,
  scale: 8,
  color: { dark: "#000000ff", light: "#ffffffff" },
};

test("browser QR stays on a tokenized no-store loopback page and rotates in memory", async () => {
  const opened = [];
  const display = await BrowserQrDisplay.start({
    openUrl: async (url) => { opened.push(url); return true; },
  });
  let closed = false;
  try {
    assert.equal(opened.length, 0);
    const first = await display.show(PAYLOAD_A);
    assert.equal(first.browserOpened, true);
    assert.deepEqual(opened, [first.url]);
    const url = new URL(first.url);
    assert.equal(url.protocol, "http:");
    assert.equal(url.hostname, "127.0.0.1");
    assert.match(url.port, /^\d+$/u);
    assert.match(url.pathname, /^\/[A-Za-z0-9_-]{43}\/$/u);
    assert.equal(first.url.includes(PAYLOAD_A), false);

    const pageResponse = await fetch(first.url);
    assertPrivateHeaders(pageResponse.headers);
    assert.match(pageResponse.headers.get("content-type"), /^text\/html/u);
    const page = await pageResponse.text();
    assert.doesNotMatch(page, /http-equiv=["']refresh/u);
    assert.match(page, /<script src="\.\/poll\.js" defer><\/script>/u);
    assert.match(page, /\.\/qr\.png\?v=1/u);
    assert.match(page, /Safe WhatsApp/u);
    assert.match(page, /Reads sync on demand\. Sending still requires your confirmation/u);
    assert.match(page, /Local only/u);
    assert.equal(page.includes(PAYLOAD_A), false);

    const scriptResponse = await fetch(new URL("./poll.js", first.url));
    assertPrivateHeaders(scriptResponse.headers);
    assert.match(scriptResponse.headers.get("content-type"), /^text\/javascript/u);
    const script = await scriptResponse.text();
    assert.match(script, /fetch\("\.\/state\.json", \{ cache: "no-store" \}\)/u);
    assert.match(script, /qr\.src = "\.\/qr\.png\?v=" \+ version/u);
    assert.match(script, /Finishing WhatsApp login/u);
    assert.match(script, /Run safewhatsapp connect again/u);
    assert.match(script, /WhatsApp couldn’t link/u);
    assert.match(script, /failures >= 3/u);
    assert.doesNotMatch(script, /location\.(?:reload|replace)|window\.location/u);
    assert.equal(script.includes(PAYLOAD_A), false);

    const stateUrl = new URL("./state.json", first.url);
    const firstStateResponse = await fetch(stateUrl);
    assertPrivateHeaders(firstStateResponse.headers);
    assert.match(firstStateResponse.headers.get("content-type"), /^application\/json/u);
    assert.deepEqual(await firstStateResponse.json(), { phase: "pairing", version: 1 });

    const imageUrl = new URL("./qr.png?v=1", first.url);
    const imageResponse = await fetch(imageUrl);
    assertPrivateHeaders(imageResponse.headers);
    assert.equal(imageResponse.headers.get("content-type"), "image/png");
    const image = Buffer.from(await imageResponse.arrayBuffer());
    assert.deepEqual(image, await QRCode.toBuffer(PAYLOAD_A, PNG_OPTIONS));
    assert.equal(image.includes(Buffer.from(PAYLOAD_A)), false);

    const head = await fetch(imageUrl, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get("content-length")), image.byteLength);
    assert.equal(head.headers.get("x-safe-whatsapp-qr-version"), "1");
    assert.equal((await head.arrayBuffer()).byteLength, 0);

    const second = await display.show(PAYLOAD_B);
    assert.deepEqual(second, { url: first.url, browserOpened: true });
    assert.deepEqual(opened, [first.url]);
    const rotatedPage = await (await fetch(first.url)).text();
    assert.match(rotatedPage, /\.\/qr\.png\?v=2/u);
    assert.deepEqual(await (await fetch(stateUrl)).json(), { phase: "pairing", version: 2 });
    const rotated = Buffer.from(await (await fetch(imageUrl)).arrayBuffer());
    assert.deepEqual(rotated, await QRCode.toBuffer(PAYLOAD_B, PNG_OPTIONS));
    assert.notDeepEqual(rotated, image);

    const missing = await fetch(new URL("/wrong-token/", first.url));
    assert.equal(missing.status, 404);
    assertPrivateHeaders(missing.headers);
    assert.equal((await missing.text()).includes(url.pathname), false);

    const forged = await rawRequest(first.url, { host: "attacker.invalid" });
    assert.equal(forged.status, 404);
    assertPrivateHeaders(forged.headers);
    assert.equal(forged.body.includes(url.pathname), false);

    const wrongTokenPost = await rawRequest(first.url, {
      method: "POST",
      path: "/wrong-token/",
    });
    assert.equal(wrongTokenPost.status, 404);
    const post = await rawRequest(first.url, { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET, HEAD");
    const scriptPost = await rawRequest(first.url, {
      method: "POST",
      path: `${url.pathname}poll.js`,
    });
    assert.equal(scriptPost.status, 405);

    await display.pairingAccepted();
    assert.deepEqual(await (await fetch(stateUrl)).json(), {
      phase: "finalizing",
      version: 2,
    });
    const finalizingPage = await (await fetch(first.url)).text();
    assert.match(finalizingPage, /Finishing WhatsApp login/u);
    assert.doesNotMatch(finalizingPage, /src="\.\/qr\.png/u);
    assert.equal((await fetch(imageUrl)).status, 503);
    await assert.rejects(display.show(PAYLOAD_A), hasCode("qr_display_unavailable"));

    const finishing = display.finish();
    const linkedState = await (await fetch(stateUrl)).json();
    assert.deepEqual(linkedState, { phase: "linked", version: 2 });
    await finishing;
    closed = true;
    await assert.rejects(fetch(first.url));
    await assert.rejects(display.show(PAYLOAD_A), hasCode("qr_display_unavailable"));
  } finally {
    if (!closed) await display.close();
    await display.close();
  }
});

test("browser opener failure preserves a usable manual loopback URL", async () => {
  const display = await BrowserQrDisplay.start({
    openUrl: () => { throw new Error("no desktop opener"); },
  });
  try {
    const result = await display.show(PAYLOAD_A);
    assert.equal(result.browserOpened, false);
    assert.equal((await fetch(result.url)).status, 200);
  } finally {
    await display.close();
  }
});

test("a linked page is stable, contains no QR, and lets finish close promptly", async () => {
  const display = await BrowserQrDisplay.start({ openUrl: async () => true });
  let closed = false;
  try {
    const { url } = await display.show(PAYLOAD_A);
    const finishing = display.finish();
    const linkedPage = await (await fetch(url)).text();
    assert.match(linkedPage, /WhatsApp linked/u);
    assert.doesNotMatch(linkedPage, /qr\.png|poll\.js|http-equiv=["']refresh/u);
    await finishing;
    closed = true;
    await assert.rejects(fetch(url));
  } finally {
    if (!closed) await display.close();
  }
});

test("a failed pairing clears the QR and shows a useful local retry state", async () => {
  const display = await BrowserQrDisplay.start({ openUrl: async () => true });
  let closed = false;
  try {
    const { url } = await display.show(PAYLOAD_A);
    const failing = display.fail();
    const failedPage = await (await fetch(url)).text();
    assert.match(failedPage, /WhatsApp couldn’t link/u);
    assert.match(failedPage, /safewhatsapp connect/u);
    assert.doesNotMatch(failedPage, /qr\.png|poll\.js/u);
    await failing;
    closed = true;
    await assert.rejects(fetch(url));
  } finally {
    if (!closed) await display.close();
  }
});

test("platform browser commands keep the private URL as one shell-free argument", () => {
  const url = "http://127.0.0.1:43210/token/";
  assert.deepEqual(browserLaunchCommand(url, "darwin"), {
    executable: "open", args: [url],
  });
  assert.deepEqual(browserLaunchCommand(url, "linux"), {
    executable: "xdg-open", args: [url],
  });
  assert.deepEqual(browserLaunchCommand(url, "win32"), {
    executable: "rundll32", args: ["url.dll,FileProtocolHandler", url],
  });
  assert.equal(browserLaunchCommand(url, "aix"), undefined);
  for (const unsafe of [
    "https://127.0.0.1:43210/token/",
    "http://localhost:43210/token/",
    "http://0.0.0.0:43210/token/",
    "http://example.com:43210/token/",
    "http://127.0.0.1/token/",
  ]) {
    assert.throws(() => browserLaunchCommand(unsafe, "darwin"), /non-loopback/u);
  }
});

function assertPrivateHeaders(headers) {
  assert.equal(headers.get("cache-control"), "no-store, no-cache, must-revalidate, private");
  assert.equal(headers.get("pragma"), "no-cache");
  assert.equal(headers.get("expires"), "0");
  assert.match(headers.get("content-security-policy"), /default-src 'none'/u);
  assert.match(headers.get("content-security-policy"), /script-src 'self'/u);
  assert.match(headers.get("content-security-policy"), /connect-src 'self'/u);
  assert.equal(headers.get("referrer-policy"), "no-referrer");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("cross-origin-resource-policy"), "same-origin");
}

function rawRequest(urlValue, options = {}) {
  const url = new URL(urlValue);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: options.path ?? url.pathname,
      method: options.method ?? "GET",
      headers: { Host: options.host ?? url.host },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: new Headers(response.headers),
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

function hasCode(code) {
  return (error) => error?.code === code;
}
