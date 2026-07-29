import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import sharp from "sharp";
import {
  fetchLinkPreview,
  findFirstHttpUrl,
  LinkPreviewError,
  sanitizePreviewImage,
} from "../dist/review/linkPreview.js";

const PUBLIC_ADDRESS = Object.freeze({ address: "1.1.1.1", family: 4 });

test("findFirstHttpUrl returns the first web URL without surrounding punctuation", () => {
  assert.equal(
    findFirstHttpUrl("See (https://example.com/a_(b)). Then http://later.test."),
    "https://example.com/a_(b)",
  );
  assert.equal(findFirstHttpUrl("invalid https:// then https://valid.test/path,"), "https://valid.test/path");
  assert.equal(findFirstHttpUrl("Visit www.example.com/path."), "www.example.com/path");
  assert.equal(findFirstHttpUrl("mailto:hello@example.com"), undefined);
});

test("fetchLinkPreview pins a validated address and returns only sanitized local metadata", async () => {
  const calls = [];
  const thumbnail = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
  const dependencies = {
    async resolve(hostname) {
      assert.ok(["page.test", "cdn.test"].includes(hostname));
      return [PUBLIC_ADDRESS];
    },
    async request(request) {
      calls.push(request);
      if (request.url.hostname === "cdn.test") {
        return response(200, { "content-type": "image/png" }, Buffer.from("safe raster bytes"));
      }
      return response(200, { "content-type": "text/html; charset=utf-8" }, Buffer.from(`
        <html><head>
          <title>Fallback title</title>
          <meta property="og:title" content=" Bliss &amp; friends ">
          <meta name="description" content=" A calm preview. ">
          <meta property="og:image" content="https://cdn.test/card.png">
          <link rel="icon" href="/fallback.png">
        </head></html>
      `));
    },
    async sanitizeImage(bytes) {
      assert.equal(Buffer.from(bytes).toString(), "safe raster bytes");
      return thumbnail;
    },
  };

  const card = await fetchLinkPreview("https://page.test/welcome#section", { dependencies });

  assert.deepEqual(card, {
    requestedUrl: "https://page.test/welcome",
    finalUrl: "https://page.test/welcome",
    title: "Bliss & friends",
    description: "A calm preview.",
    jpegThumbnail: thumbnail,
  });
  assert.equal("imageUrl" in card, false);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.deepEqual(call.pinnedAddress, PUBLIC_ADDRESS);
    const headers = lowerCaseHeaders(call.headers);
    assert.equal(headers["accept-encoding"], "identity");
    assert.equal(headers.connection, "close");
    assert.equal(headers.cookie, undefined);
    assert.equal(headers.authorization, undefined);
    assert.equal(headers.referer, undefined);
  }
});

test("fetchLinkPreview falls back to a page icon when social image metadata is absent", async () => {
  const requestedPaths = [];
  const thumbnail = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
  const dependencies = {
    async resolve() {
      return [PUBLIC_ADDRESS];
    },
    async request(request) {
      requestedPaths.push(request.url.pathname);
      if (request.url.pathname === "/assets/logo.png") {
        return response(200, { "content-type": "image/png" }, Buffer.from("page icon"));
      }
      return htmlResponse('<title>Bliss</title><link rel="icon" type="image/png" href="assets/logo.png">');
    },
    async sanitizeImage(bytes) {
      assert.equal(Buffer.from(bytes).toString(), "page icon");
      return thumbnail;
    },
  };

  const card = await fetchLinkPreview("https://page.test/", { dependencies });

  assert.equal(card.title, "Bliss");
  assert.deepEqual(card.jpegThumbnail, thumbnail);
  assert.deepEqual(requestedPaths, ["/", "/assets/logo.png"]);
});

test("fetchLinkPreview rejects credentials, non-web protocols, and nonstandard ports before DNS", async () => {
  let resolutions = 0;
  const dependencies = {
    async resolve() {
      resolutions += 1;
      return [PUBLIC_ADDRESS];
    },
  };
  for (const input of [
    "ftp://example.com/file",
    "https://user:secret@example.com/",
    "https://example.com:8443/",
  ]) {
    await rejectsWithCode(() => fetchLinkPreview(input, { dependencies }), "invalid_url");
  }
  assert.equal(resolutions, 0);
});

test("fetchLinkPreview rejects a DNS answer set when any address is not public", async () => {
  let requests = 0;
  const dependencies = {
    async resolve() {
      return [PUBLIC_ADDRESS, { address: "127.0.0.1", family: 4 }];
    },
    async request() {
      requests += 1;
      return htmlResponse("<title>Unsafe</title>");
    },
  };

  await rejectsWithCode(() => fetchLinkPreview("https://mixed.test/", { dependencies }), "unsafe_address");
  assert.equal(requests, 0);
});

test("fetchLinkPreview rejects unsafe IPv4 and IPv6 literals without consulting DNS", async () => {
  let resolutions = 0;
  const dependencies = {
    async resolve() {
      resolutions += 1;
      return [PUBLIC_ADDRESS];
    },
  };
  for (const input of [
    "http://127.0.0.1/",
    "http://169.254.1.1/",
    "http://0.0.0.0/",
    "http://198.18.0.1/",
    "http://[::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[2001:db8::1]/",
  ]) {
    await rejectsWithCode(() => fetchLinkPreview(input, { dependencies }), "unsafe_address");
  }
  assert.equal(resolutions, 0);
});

test("fetchLinkPreview resolves and validates every redirect, including same-host hops", async () => {
  const resolved = [];
  let requests = 0;
  const dependencies = {
    async resolve(hostname) {
      resolved.push(hostname);
      return [PUBLIC_ADDRESS];
    },
    async request(request) {
      requests += 1;
      const step = Number(request.url.pathname.slice(1));
      if (step < 3) return response(302, { location: `/${step + 1}` }, Buffer.from("ignored"));
      return htmlResponse("<title>Final</title>");
    },
  };

  const card = await fetchLinkPreview("https://redirect.test/0", { dependencies });
  assert.equal(card.finalUrl, "https://redirect.test/3");
  assert.equal(card.title, "Final");
  assert.equal(requests, 4);
  assert.deepEqual(resolved, ["redirect.test", "redirect.test", "redirect.test", "redirect.test"]);
});

test("fetchLinkPreview enforces a maximum of three redirects", async () => {
  let requests = 0;
  const dependencies = {
    async resolve() {
      return [PUBLIC_ADDRESS];
    },
    async request(request) {
      requests += 1;
      const step = Number(request.url.pathname.slice(1));
      return response(302, { location: `/${step + 1}` }, Buffer.from("ignored"));
    },
  };

  await rejectsWithCode(
    () => fetchLinkPreview("https://redirect.test/0", { dependencies }),
    "too_many_redirects",
  );
  assert.equal(requests, 4);
});

test("fetchLinkPreview blocks a redirect that changes to a private destination", async () => {
  const resolutions = [];
  let requests = 0;
  const dependencies = {
    async resolve(hostname) {
      resolutions.push(hostname);
      return hostname === "private.test"
        ? [{ address: "10.0.0.2", family: 4 }]
        : [PUBLIC_ADDRESS];
    },
    async request() {
      requests += 1;
      return response(302, { location: "http://private.test/admin" }, Buffer.from("ignored"));
    },
  };

  await rejectsWithCode(() => fetchLinkPreview("https://public.test/", { dependencies }), "unsafe_address");
  assert.deepEqual(resolutions, ["public.test", "private.test"]);
  assert.equal(requests, 1);
});

test("fetchLinkPreview applies the HTML cap after content decoding", async () => {
  const oversizedHtml = gzipSync(Buffer.alloc(512 * 1_024 + 1, 0x61));
  const dependencies = fixedDependencies(() => response(200, {
    "content-type": "text/html",
    "content-encoding": "gzip",
  }, oversizedHtml));

  await rejectsWithCode(
    () => fetchLinkPreview("https://large.test/", { dependencies }),
    "response_too_large",
  );
});

test("fetchLinkPreview refuses an oversized image while preserving safe text metadata", async () => {
  let sanitizations = 0;
  const dependencies = {
    async resolve() {
      return [PUBLIC_ADDRESS];
    },
    async request(request) {
      if (request.url.pathname === "/image.png") {
        return response(200, { "content-type": "image/png" }, Buffer.alloc(2 * 1_024 * 1_024 + 1));
      }
      return htmlResponse('<meta property="og:title" content="Text survives"><meta property="og:image" content="/image.png">');
    },
    async sanitizeImage() {
      sanitizations += 1;
      return Uint8Array.from([1]);
    },
  };

  const card = await fetchLinkPreview("https://image.test/page", { dependencies });
  assert.equal(card.title, "Text survives");
  assert.equal(card.jpegThumbnail, undefined);
  assert.equal(sanitizations, 0);
});

test("fetchLinkPreview never requests an image hosted on a private address", async () => {
  let requests = 0;
  const dependencies = {
    async resolve(hostname) {
      return hostname === "private-image.test"
        ? [{ address: "192.168.1.20", family: 4 }]
        : [PUBLIC_ADDRESS];
    },
    async request() {
      requests += 1;
      return htmlResponse('<title>Safe text</title><meta property="og:image" content="http://private-image.test/x.png">');
    },
  };

  const card = await fetchLinkPreview("https://page.test/", { dependencies });
  assert.equal(card.title, "Safe text");
  assert.equal(card.jpegThumbnail, undefined);
  assert.equal(requests, 1);
});

test("fetchLinkPreview enforces one bounded timeout even when an injected request stalls", async () => {
  const dependencies = {
    async resolve() {
      return [PUBLIC_ADDRESS];
    },
    async request() {
      return await new Promise(() => {});
    },
  };
  const started = Date.now();

  await rejectsWithCode(
    () => fetchLinkPreview("https://stall.test/", { dependencies, timeoutMs: 25 }),
    "timeout",
  );
  assert.ok(Date.now() - started < 500, "the abort budget should win over a stalled transport");
});

test("sanitizePreviewImage emits a bounded JPEG and refuses vector input", async () => {
  const source = await sharp({
    create: {
      width: 1_600,
      height: 900,
      channels: 4,
      background: { r: 38, g: 124, b: 99, alpha: 0.7 },
    },
  }).png().toBuffer();

  const thumbnail = await sanitizePreviewImage(source);
  assert.ok(thumbnail);
  assert.ok(thumbnail.byteLength <= 64 * 1_024);
  const metadata = await sharp(thumbnail).metadata();
  assert.equal(metadata.format, "jpeg");
  assert.ok(metadata.width <= 512);
  assert.ok(metadata.height <= 512);

  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>');
  assert.equal(await sanitizePreviewImage(svg), undefined);
});

function fixedDependencies(request) {
  return {
    async resolve() {
      return [PUBLIC_ADDRESS];
    },
    async request(input) {
      return request(input);
    },
  };
}

function htmlResponse(html) {
  return response(200, { "content-type": "text/html; charset=utf-8" }, Buffer.from(html));
}

function response(statusCode, headers, body) {
  const bytes = Buffer.from(body);
  return {
    statusCode,
    headers,
    body: (async function* () {
      yield bytes;
    })(),
  };
}

function lowerCaseHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

async function rejectsWithCode(operation, code) {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof LinkPreviewError);
    assert.equal(error.code, code);
    return true;
  });
}
