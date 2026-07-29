// Agent context note: Fetches one bounded public-web preview through DNS-validated, address-pinned requests and converts optional social or page-icon art to a small local JPEG. Tests: test/link-preview.test.mjs. Prefer social metadata, safely fall back to raster page icons, revalidate every redirect and image hop, share one five-second budget, and never return a remote image URL.

import { promises as dns } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { Parser } from "htmlparser2";
import ipaddr from "ipaddr.js";
import sharp from "sharp";
import type {
  LinkPreviewCard,
  LinkPreviewDependencies,
  LinkPreviewFetchOptions,
  LinkPreviewHttpRequest,
  LinkPreviewHttpResponse,
  ResolvedAddress,
} from "./linkPreviewTypes.js";

export type {
  LinkPreviewCard,
  LinkPreviewDependencies,
  LinkPreviewFetchOptions,
  LinkPreviewHttpRequest,
  LinkPreviewHttpResponse,
  ResolvedAddress,
} from "./linkPreviewTypes.js";

const MAX_URL_LENGTH = 2_048;
const MAX_HTML_BYTES = 512 * 1_024;
const MAX_IMAGE_BYTES = 2 * 1_024 * 1_024;
const MAX_THUMBNAIL_BYTES = 64 * 1_024;
const MAX_REDIRECTS = 3;
const MAX_TIMEOUT_MS = 5_000;
const ALLOWED_RASTER_FORMATS = new Set(["avif", "gif", "jpeg", "png", "tiff", "webp"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BLOCKED_SUBNETS = compileBlockedSubnets([
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::/96",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "100::/64",
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "3fff::/20",
  "5f00::/16",
  "fc00::/7",
  "fe80::/10",
  "fec0::/10",
  "ff00::/8",
]);

export type LinkPreviewErrorCode =
  | "invalid_url"
  | "unsafe_address"
  | "dns_failed"
  | "network_failed"
  | "timeout"
  | "too_many_redirects"
  | "invalid_response"
  | "response_too_large";

export class LinkPreviewError extends Error {
  constructor(readonly code: LinkPreviewErrorCode) {
    super(errorMessage(code));
    this.name = "LinkPreviewError";
  }
}

interface FetchedResource {
  finalUrl: URL;
  contentType: string;
  bytes: Uint8Array;
}

interface ParsedMetadata {
  title?: string;
  description?: string;
  imageUrl?: string;
}

interface ByteSubnet {
  bytes: readonly number[];
  prefixLength: number;
}

export function findFirstHttpUrl(text: string): string | undefined {
  const matches = text.matchAll(/(?:^|[^A-Za-z0-9@])((?:https?:\/\/|www\.)[^\s<>"'\x60\u0000-\u001f\u007f]+)/giu);
  for (const match of matches) {
    const candidate = trimTrailingPunctuation(match[1]!).slice(0, MAX_URL_LENGTH + 1);
    if (candidate.length === 0 || candidate.length > MAX_URL_LENGTH) continue;
    try {
      const parsed = new URL(/^www\./iu.test(candidate) ? "https://" + candidate : candidate);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return candidate;
    } catch {
      // Continue to the next URL-shaped token.
    }
  }
  return undefined;
}

export async function fetchLinkPreview(
  input: string,
  options: LinkPreviewFetchOptions = {},
): Promise<LinkPreviewCard> {
  const requestedUrl = parseSafeUrl(input);
  const controller = new AbortController();
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1, options.timeoutMs ?? MAX_TIMEOUT_MS));
  const timeout = setTimeout(() => controller.abort(new Error("preview timeout")), timeoutMs);
  const relayAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", relayAbort, { once: true });
  if (options.signal?.aborted) relayAbort();

  const dependencies: LinkPreviewDependencies = {
    resolve: options.dependencies?.resolve ?? resolveAddresses,
    request: options.dependencies?.request ?? requestPinned,
    sanitizeImage: options.dependencies?.sanitizeImage ?? sanitizePreviewImage,
  };

  try {
    const html = await fetchResource(
      requestedUrl,
      "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
      MAX_HTML_BYTES,
      dependencies,
      controller.signal,
    );
    if (!isHtmlContentType(html.contentType)) throw new LinkPreviewError("invalid_response");

    const metadata = parseMetadata(new TextDecoder().decode(html.bytes));
    const title = metadata.title ?? cleanMetadata(html.finalUrl.hostname, 200);
    const card: LinkPreviewCard = {
      requestedUrl: requestedUrl.href,
      finalUrl: html.finalUrl.href,
      title,
    };
    if (metadata.description) card.description = metadata.description;

    if (metadata.imageUrl && !controller.signal.aborted) {
      try {
        const imageUrl = parseSafeUrl(metadata.imageUrl, html.finalUrl);
        const image = await fetchResource(
          imageUrl,
          "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.8,*/*;q=0.1",
          MAX_IMAGE_BYTES,
          dependencies,
          controller.signal,
        );
        if (isRasterContentType(image.contentType)) {
          const thumbnail = await raceWithAbort(dependencies.sanitizeImage(image.bytes), controller.signal);
          if (thumbnail && thumbnail.byteLength <= MAX_THUMBNAIL_BYTES && hasJpegSignature(thumbnail)) {
            card.jpegThumbnail = new Uint8Array(thumbnail);
          }
        }
      } catch (error) {
        if (controller.signal.aborted) throw error;
        // A preview image is optional. Keep the text card when it is unsafe or unavailable.
      }
    }

    if (controller.signal.aborted) throw new LinkPreviewError("timeout");
    return card;
  } catch (error) {
    if (error instanceof LinkPreviewError) throw error;
    if (controller.signal.aborted) throw new LinkPreviewError("timeout");
    throw new LinkPreviewError("network_failed");
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", relayAbort);
  }
}

export async function sanitizePreviewImage(bytes: Uint8Array): Promise<Uint8Array | undefined> {
  try {
    const input = sharp(bytes, {
      animated: false,
      failOn: "warning",
      limitInputPixels: 16_777_216,
      sequentialRead: true,
    });
    const metadata = await input.metadata();
    if (!metadata.format || !ALLOWED_RASTER_FORMATS.has(metadata.format)) return undefined;
    if (!metadata.width || !metadata.height) return undefined;

    for (const dimension of [512, 448, 384, 320, 256, 192]) {
      for (const quality of [72, 60, 48, 36, 24]) {
        const output = await input
          .clone()
          .rotate()
          .resize({ width: dimension, height: dimension, fit: "inside", withoutEnlargement: true })
          .flatten({ background: "#ffffff" })
          .jpeg({ quality, progressive: false })
          .toBuffer();
        if (output.byteLength <= MAX_THUMBNAIL_BYTES) return new Uint8Array(output);
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function fetchResource(
  initialUrl: URL,
  accept: string,
  byteLimit: number,
  dependencies: LinkPreviewDependencies,
  signal: AbortSignal,
): Promise<FetchedResource> {
  let current = initialUrl;
  for (let redirects = 0; ; redirects += 1) {
    throwIfAborted(signal);
    const addresses = await resolveAndValidate(current.hostname, dependencies, signal);
    const response = await safeRequest({
      url: current,
      pinnedAddress: addresses[0]!,
      headers: Object.freeze({
        Accept: accept,
        "Accept-Encoding": "identity",
        Connection: "close",
        "User-Agent": "safe-whatsapp-mcp-link-preview/1",
      }),
      signal,
    }, dependencies);

    try {
      if (REDIRECT_STATUSES.has(response.statusCode)) {
        if (redirects >= MAX_REDIRECTS) throw new LinkPreviewError("too_many_redirects");
        const location = singleHeader(response.headers, "location");
        if (!location || location.length > MAX_URL_LENGTH) {
          throw new LinkPreviewError("invalid_response");
        }
        current = parseSafeUrl(location, current);
        continue;
      }
      if (response.statusCode !== 200) throw new LinkPreviewError("invalid_response");

      const contentLength = singleHeader(response.headers, "content-length");
      if (contentLength && !contentLengthFits(contentLength, byteLimit)) {
        throw new LinkPreviewError("response_too_large");
      }
      const bytes = await readCappedBody(response, byteLimit, signal);
      return {
        finalUrl: current,
        contentType: singleHeader(response.headers, "content-type") ?? "",
        bytes,
      };
    } finally {
      response.dispose?.();
    }
  }
}

async function resolveAndValidate(
  hostname: string,
  dependencies: LinkPreviewDependencies,
  signal: AbortSignal,
): Promise<readonly ResolvedAddress[]> {
  const literal = stripIpv6Brackets(hostname);
  const literalFamily = isIP(literal);
  let addresses: readonly ResolvedAddress[];
  try {
    addresses = literalFamily
      ? [{ address: literal, family: literalFamily as 4 | 6 }]
      : await raceWithAbort(dependencies.resolve(hostname, signal), signal);
  } catch {
    if (signal.aborted) throw new LinkPreviewError("timeout");
    throw new LinkPreviewError("dns_failed");
  }
  if (addresses.length === 0) throw new LinkPreviewError("dns_failed");
  if (addresses.some((address) => !isSafePublicAddress(address))) {
    throw new LinkPreviewError("unsafe_address");
  }
  return addresses;
}

async function safeRequest(
  request: LinkPreviewHttpRequest,
  dependencies: LinkPreviewDependencies,
): Promise<LinkPreviewHttpResponse> {
  try {
    return await raceWithAbort(dependencies.request(request), request.signal);
  } catch {
    if (request.signal.aborted) throw new LinkPreviewError("timeout");
    throw new LinkPreviewError("network_failed");
  }
}

async function resolveAddresses(hostname: string, signal: AbortSignal): Promise<readonly ResolvedAddress[]> {
  throwIfAborted(signal);
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  throwIfAborted(signal);
  return records.map((record) => ({ address: record.address, family: record.family as 4 | 6 }));
}

async function requestPinned(request: LinkPreviewHttpRequest): Promise<LinkPreviewHttpResponse> {
  throwIfAborted(request.signal);
  const transport = request.url.protocol === "https:" ? https : http;
  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const outgoing = transport.request({
      protocol: request.url.protocol,
      hostname: request.pinnedAddress.address,
      port: effectivePort(request.url),
      path: `${request.url.pathname}${request.url.search}`,
      method: "GET",
      headers: { ...request.headers, Host: request.url.host },
      agent: false,
      signal: request.signal,
      maxHeaderSize: 16 * 1_024,
      ...(request.url.protocol === "https:" ? { servername: stripIpv6Brackets(request.url.hostname) } : {}),
    }, resolve);
    outgoing.once("error", reject);
    outgoing.setNoDelay(true);
    outgoing.end();
  });
  return {
    statusCode: response.statusCode ?? 0,
    headers: response.headers,
    body: response,
    dispose: () => response.destroy(),
  };
}

async function readCappedBody(
  response: LinkPreviewHttpResponse,
  byteLimit: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const decoded = decodedBody(response);
  const chunks: Buffer[] = [];
  let total = 0;
  const iterator = decoded[Symbol.asyncIterator]();
  try {
    while (true) {
      const item = await raceWithAbort(iterator.next(), signal);
      if (item.done) break;
      const value = item.value;
      throwIfAborted(signal);
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > byteLimit) throw new LinkPreviewError("response_too_large");
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof LinkPreviewError) throw error;
    if (signal.aborted) throw new LinkPreviewError("timeout");
    throw new LinkPreviewError("invalid_response");
  }
  if (total === 0) throw new LinkPreviewError("invalid_response");
  return new Uint8Array(Buffer.concat(chunks, total));
}

function decodedBody(response: LinkPreviewHttpResponse): AsyncIterable<Uint8Array> {
  const encoding = (singleHeader(response.headers, "content-encoding") ?? "identity").trim().toLowerCase();
  const source = Readable.from(response.body);
  if (encoding === "" || encoding === "identity") return source;
  if (encoding === "gzip" || encoding === "x-gzip") return source.pipe(createGunzip());
  if (encoding === "deflate") return source.pipe(createInflate());
  if (encoding === "br") return source.pipe(createBrotliDecompress());
  throw new LinkPreviewError("invalid_response");
}

function parseMetadata(html: string): ParsedMetadata {
  let titleText = "";
  let inTitle = false;
  const values = new Map<string, string>();
  const parser = new Parser({
    onopentag(name: string, attributes: Record<string, string>) {
      if (name === "title") inTitle = true;
      if (name === "link") {
        const relations = new Set((attributes.rel ?? "").trim().toLowerCase().split(/\s+/u));
        const href = attributes.href;
        if (href && relations.has("apple-touch-icon") && !values.has("link:apple-touch-icon")) {
          values.set("link:apple-touch-icon", href);
        } else if (href && relations.has("icon") && !values.has("link:icon")) {
          values.set("link:icon", href);
        }
      }
      if (name !== "meta") return;
      const key = (attributes.property ?? attributes.name ?? "").trim().toLowerCase();
      const content = attributes.content;
      if (key && content && !values.has(key)) values.set(key, content);
    },
    ontext(text: string) {
      if (inTitle && titleText.length < 4_096) titleText += text.slice(0, 4_096 - titleText.length);
    },
    onclosetag(name: string) {
      if (name === "title") inTitle = false;
    },
  }, { decodeEntities: true });
  parser.end(html);

  const title = firstClean([
    values.get("og:title"),
    values.get("twitter:title"),
    titleText,
  ], 200);
  const description = firstClean([
    values.get("og:description"),
    values.get("description"),
    values.get("twitter:description"),
  ], 500);
  const imageUrl = firstClean([
    values.get("og:image:secure_url"),
    values.get("og:image"),
    values.get("twitter:image"),
    values.get("twitter:image:src"),
    values.get("link:apple-touch-icon"),
    values.get("link:icon"),
  ], MAX_URL_LENGTH);
  return { title, description, imageUrl };
}

function parseSafeUrl(input: string, base?: URL): URL {
  if (input.length === 0 || input.length > MAX_URL_LENGTH) throw new LinkPreviewError("invalid_url");
  let parsed: URL;
  try {
    parsed = base ? new URL(input, base) : new URL(input);
  } catch {
    throw new LinkPreviewError("invalid_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new LinkPreviewError("invalid_url");
  }
  if (parsed.username || parsed.password) throw new LinkPreviewError("invalid_url");
  const port = effectivePort(parsed);
  if (port !== 80 && port !== 443) throw new LinkPreviewError("invalid_url");
  if (!parsed.hostname || parsed.hostname.length > 253) throw new LinkPreviewError("invalid_url");
  parsed.hash = "";
  return parsed;
}

function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function isSafePublicAddress(record: ResolvedAddress): boolean {
  if (record.address.includes("%") || isIP(record.address) !== record.family) return false;
  try {
    const parsed = ipaddr.parse(record.address);
    if ((record.family === 4 && parsed.kind() !== "ipv4") || (record.family === 6 && parsed.kind() !== "ipv6")) {
      return false;
    }
    return parsed.range() === "unicast" && !BLOCKED_SUBNETS.some((subnet) => matchesSubnet(
      parsed.toByteArray(),
      subnet,
    ));
  } catch {
    return false;
  }
}

function contentLengthFits(value: string, byteLimit: number): boolean {
  if (!/^\d{1,12}$/.test(value)) return false;
  const size = Number(value);
  return Number.isSafeInteger(size) && size >= 0 && size <= byteLimit;
}

function singleHeader(
  headers: LinkPreviewHttpResponse["headers"],
  name: string,
): string | undefined {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  if (!found || found[1] === undefined) return undefined;
  if (Array.isArray(found[1])) return found[1].length === 1 ? found[1][0] : undefined;
  return found[1] as string;
}

function isHtmlContentType(value: string): boolean {
  const mime = value.split(";", 1)[0]!.trim().toLowerCase();
  return mime === "text/html" || mime === "application/xhtml+xml";
}

function isRasterContentType(value: string): boolean {
  const mime = value.split(";", 1)[0]!.trim().toLowerCase();
  return new Set(["image/avif", "image/gif", "image/jpeg", "image/png", "image/tiff", "image/webp"]).has(mime);
}

function hasJpegSignature(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[bytes.byteLength - 2] === 0xff
    && bytes[bytes.byteLength - 1] === 0xd9;
}

function firstClean(values: readonly (string | undefined)[], maxLength: number): string | undefined {
  for (const value of values) {
    if (!value) continue;
    const cleaned = cleanMetadata(value, maxLength);
    if (cleaned) return cleaned;
  }
  return undefined;
}

function cleanMetadata(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

function trimTrailingPunctuation(value: string): string {
  let result = value.replace(/[.,!?:;]+$/u, "");
  const pairs: readonly [string, string][] = [["(", ")"], ["[", "]"], ["{", "}"]];
  for (const [open, close] of pairs) {
    while (result.endsWith(close) && count(result, close) > count(result, open)) result = result.slice(0, -1);
  }
  return result;
}

function count(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new LinkPreviewError("timeout");
}

async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return await new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      reject(new LinkPreviewError("timeout"));
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function compileBlockedSubnets(values: readonly string[]): readonly ByteSubnet[] {
  return values.map((value) => {
    const [address, prefixLength] = ipaddr.parseCIDR(value);
    return { bytes: address.toByteArray(), prefixLength };
  });
}

function matchesSubnet(bytes: readonly number[], subnet: ByteSubnet): boolean {
  if (bytes.length !== subnet.bytes.length) return false;
  const wholeBytes = Math.floor(subnet.prefixLength / 8);
  for (let index = 0; index < wholeBytes; index += 1) {
    if (bytes[index] !== subnet.bytes[index]) return false;
  }
  const remainingBits = subnet.prefixLength % 8;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (bytes[wholeBytes]! & mask) === (subnet.bytes[wholeBytes]! & mask);
}

function errorMessage(code: LinkPreviewErrorCode): string {
  switch (code) {
    case "invalid_url": return "The preview URL is not allowed.";
    case "unsafe_address": return "The preview destination is not public.";
    case "dns_failed": return "The preview destination could not be resolved.";
    case "timeout": return "The preview request timed out.";
    case "too_many_redirects": return "The preview redirected too many times.";
    case "response_too_large": return "The preview response was too large.";
    case "invalid_response": return "The preview response was not usable.";
    case "network_failed": return "The preview request failed.";
  }
}
