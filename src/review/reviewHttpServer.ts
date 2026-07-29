// Agent context note: Serves capability-scoped review pages on IPv4 loopback with strict same-origin mutations and bounded bodies. Tests: test/review-http-server.test.mjs. Keep route/action secrets out of responses and logs, reject cross-origin access, and serve only same-review media.
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { publicError, SafeWhatsAppError } from "../errors.js";
import type { OutboundMediaContent } from "../media/types.js";
import { reviewPageCss, reviewPageHtml, reviewPageScript } from "./reviewPage.js";
import type { ReviewPageState, ReviewSession } from "./types.js";

const HOST = "127.0.0.1";
const JSON_LIMIT = 64 * 1024;

export interface ReviewHttpDelegate {
  findByRoute(routeToken: string): ReviewSession | undefined;
  pageState(session: ReviewSession): ReviewPageState;
  loadPreview(session: ReviewSession, url: string): Promise<void>;
  replaceAttachment(session: ReviewSession, bytes: Uint8Array, fileName: string): Promise<void>;
  removeAttachment(session: ReviewSession): Promise<void>;
  readAttachment(session: ReviewSession): Promise<OutboundMediaContent>;
  cancel(session: ReviewSession): Promise<void>;
  send(session: ReviewSession, body: unknown): Promise<void>;
}

export class ReviewHttpServer {
  private readonly listener: Server;
  private starting?: Promise<void>;
  private port?: number;

  constructor(
    private readonly delegate: ReviewHttpDelegate,
    private readonly maxMediaBytes: number,
  ) {
    this.listener = createServer((request, response) => {
      void this.handle(request, response).catch((error) => this.fail(response, error));
    });
    this.listener.on("clientError", (_error, socket) => socket.destroy());
  }

  get listening(): boolean {
    return this.listener.listening;
  }

  async start(): Promise<void> {
    if (this.listener.listening && this.port) return;
    if (this.starting) {
      await this.starting;
      return;
    }
    this.starting ??= new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.listener.off("listening", onListening);
        this.starting = undefined;
        reject(error);
      };
      const onListening = () => {
        this.listener.off("error", onError);
        this.port = (this.listener.address() as AddressInfo).port;
        resolve();
      };
      this.listener.once("error", onError);
      this.listener.once("listening", onListening);
      this.listener.listen({ host: HOST, port: 0, exclusive: true });
    });
    await this.starting;
  }

  urlFor(session: ReviewSession): string {
    if (!this.port) throw new Error("Review server is not listening.");
    return `${this.origin}/review/${session.routeToken}/#action=${session.actionToken}`;
  }

  async close(): Promise<void> {
    if (!this.listener.listening) return;
    await new Promise<void>((resolve) => this.listener.close(() => resolve()));
    this.port = undefined;
    this.starting = undefined;
  }

  private get origin(): string {
    if (!this.port) throw new Error("Review server is not listening.");
    return `http://${HOST}:${this.port}`;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.port || request.socket.remoteAddress !== HOST) throw httpError(403, "review_forbidden");
    if (request.headers.host !== `${HOST}:${this.port}`) throw httpError(421, "review_forbidden");
    if (!request.url) throw httpError(404, "review_not_found");
    const url = new URL(request.url, this.origin);
    const match = /^\/review\/([A-Za-z0-9_-]{43})\/(.*)$/u.exec(url.pathname);
    if (!match || url.search || url.username || url.password) throw httpError(404, "review_not_found");
    const session = this.delegate.findByRoute(match[1]!);
    if (!session) throw httpError(404, "review_not_found");
    const route = match[2]!;
    const method = request.method ?? "GET";
    if (method === "OPTIONS") throw httpError(405, "method_not_allowed");
    if (isMutation(method)) this.assertMutation(request, session);
    else if (request.headers.origin && request.headers.origin !== this.origin) {
      throw httpError(403, "review_forbidden");
    }

    if (route === "" && isRead(method)) return this.static(response, method, "text/html; charset=utf-8", reviewPageHtml());
    if (route === "review.css" && isRead(method)) return this.static(response, method, "text/css; charset=utf-8", reviewPageCss());
    if (route === "review.js" && isRead(method)) return this.static(response, method, "text/javascript; charset=utf-8", reviewPageScript());
    if (route === "api" && isRead(method)) return this.json(response, 200, this.delegate.pageState(session), method);
    if (route === "attachment" && isRead(method)) return this.attachment(response, request, session, method);
    if (route === "attachment" && method === "PUT") {
      const name = decodeFileName(request.headers["x-safe-file-name"]);
      const bytes = await readBody(request, this.maxMediaBytes);
      await this.delegate.replaceAttachment(session, bytes, name);
      return this.json(response, 200, this.delegate.pageState(session));
    }
    if (route === "attachment" && method === "DELETE") {
      assertEmptyBody(request);
      await this.delegate.removeAttachment(session);
      return this.json(response, 200, this.delegate.pageState(session));
    }
    if (route === "link-thumbnail" && isRead(method)) {
      const bytes = session.linkPreview?.jpegThumbnail;
      if (!bytes) throw httpError(404, "preview_not_found");
      return this.bytes(response, method, 200, "image/jpeg", bytes);
    }
    if (route === "preview" && method === "POST") {
      requireJson(request);
      const body = parseJson(await readBody(request, JSON_LIMIT));
      if (!isExactRecord(body, ["url"]) || typeof body.url !== "string" || body.url.length > 2_048) {
        throw httpError(400, "invalid_url");
      }
      await this.delegate.loadPreview(session, body.url);
      return this.json(response, 200, this.delegate.pageState(session));
    }
    if (route === "cancel" && method === "POST") {
      requireJson(request);
      const body = parseJson(await readBody(request, JSON_LIMIT));
      if (!isExactRecord(body, [])) throw httpError(400, "invalid_request");
      await this.delegate.cancel(session);
      return this.json(response, 200, this.delegate.pageState(session));
    }
    if (route === "send" && method === "POST") {
      requireJson(request);
      const body = parseJson(await readBody(request, JSON_LIMIT));
      await this.delegate.send(session, body);
      return this.json(response, 202, this.delegate.pageState(session));
    }
    throw httpError(405, "method_not_allowed");
  }

  private assertMutation(request: IncomingMessage, session: ReviewSession): void {
    if (request.headers.origin !== this.origin) throw httpError(403, "review_forbidden");
    const fetchSite = request.headers["sec-fetch-site"];
    if (fetchSite && fetchSite !== "same-origin") throw httpError(403, "review_forbidden");
    const token = request.headers["x-safe-whatsapp-action"];
    if (typeof token !== "string" || !secretMatches(token, session.actionToken)) {
      throw httpError(403, "review_forbidden");
    }
  }

  private async attachment(
    response: ServerResponse,
    request: IncomingMessage,
    session: ReviewSession,
    method: string,
  ): Promise<void> {
    if (!session.media) throw httpError(404, "attachment_not_found");
    const media = await this.delegate.readAttachment(session);
    const range = parseRange(request.headers.range, media.bytes.byteLength);
    const disposition = `inline; filename="attachment"; filename*=UTF-8''${encodeURIComponent(media.originalName)}`;
    response.setHeader("Content-Disposition", disposition);
    response.setHeader("Accept-Ranges", "bytes");
    if (!range) return this.bytes(response, method, 200, inlineMime(media), media.bytes);
    response.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${media.bytes.byteLength}`);
    return this.bytes(response, method, 206, inlineMime(media), media.bytes.subarray(range.start, range.end + 1));
  }

  private static(response: ServerResponse, method: string, type: string, value: string): void {
    this.bytes(response, method, 200, type, Buffer.from(value, "utf8"));
  }

  private json(response: ServerResponse, status: number, value: unknown, method = "GET"): void {
    this.bytes(response, method, status, "application/json; charset=utf-8", Buffer.from(JSON.stringify(value), "utf8"));
  }

  private bytes(
    response: ServerResponse,
    method: string,
    status: number,
    type: string,
    value: Uint8Array,
  ): void {
    securityHeaders(response);
    response.statusCode = status;
    response.setHeader("Content-Type", type);
    response.setHeader("Content-Length", String(value.byteLength));
    if (method === "HEAD") response.end();
    else response.end(value);
  }

  private fail(response: ServerResponse, error: unknown): void {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const status = error instanceof ReviewHttpError
      ? error.status
      : error instanceof SafeWhatsAppError ? 400 : 500;
    const details = error instanceof ReviewHttpError
      ? { code: error.code, message: error.message }
      : publicError(error);
    this.json(response, status, { errorCode: details.code });
  }
}

class ReviewHttpError extends SafeWhatsAppError {
  constructor(readonly status: number, code: string) {
    super("The local review request was rejected.", code);
  }
}

function httpError(status: number, code: string): ReviewHttpError {
  return new ReviewHttpError(status, code);
}

function isRead(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

function isMutation(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "DELETE" || method === "PATCH";
}

function secretMatches(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()");
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const length = request.headers["content-length"];
  if (length && (!/^\d+$/u.test(length) || Number(length) > limit)) throw httpError(413, "request_too_large");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of request) {
    const chunk = Buffer.from(raw);
    total += chunk.byteLength;
    if (total > limit) throw httpError(413, "request_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function assertEmptyBody(request: IncomingMessage): void {
  const length = request.headers["content-length"];
  if (length && length !== "0") throw httpError(400, "invalid_request");
}

function requireJson(request: IncomingMessage): void {
  if (request.headers["content-type"] !== "application/json") throw httpError(415, "invalid_content_type");
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    throw httpError(400, "invalid_request");
  }
}

function isExactRecord(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function decodeFileName(value: string | string[] | undefined): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024) {
    throw httpError(400, "invalid_file_name");
  }
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded.length > 255) throw new Error("invalid");
    return decoded;
  } catch {
    throw httpError(400, "invalid_file_name");
  }
}

function inlineMime(media: OutboundMediaContent): string {
  const allowed = media.kind === "image"
    ? new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"])
    : media.kind === "video"
      ? new Set(["video/mp4", "video/webm", "video/quicktime"])
      : media.kind === "audio"
        ? new Set(["audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "audio/webm"])
        : new Set<string>();
  return allowed.has(media.mimeType) ? media.mimeType : "application/octet-stream";
}

function parseRange(value: string | undefined, size: number): { start: number; end: number } | undefined {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (!match || (!match[1] && !match[2])) throw httpError(416, "invalid_range");
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[2] && match[1] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || end >= size) {
    throw httpError(416, "invalid_range");
  }
  return { start, end };
}
