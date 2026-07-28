// Agent context note: Serves an in-memory pairing QR on a stable, state-polled, tokenized IPv4-loopback page. Tests: test/browser-qr.test.mjs. Never persist or log QR data, bind beyond loopback, weaken no-store/browser headers, or remove token checks; update this note after meaningful changes.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import QRCode from "qrcode";
import { SafeWhatsAppError } from "../errors.js";
import { openLocalBrowser } from "./openBrowser.js";
import {
  PAIRING_POLL_SCRIPT,
  renderPairingPage,
  type PairingPhase,
} from "./pairingPage.js";

type OpenUrl = (url: string) => Promise<boolean>;

export interface BrowserQrResult {
  url: string;
  browserOpened: boolean;
}

export class BrowserQrDisplay {
  private png?: Buffer;
  private version = 0;
  private browserAttempted = false;
  private browserOpened = false;
  private closed = false;
  private phase: PairingPhase = "pairing";
  private origin = "";
  private updates = Promise.resolve();
  private resolveTerminalState!: () => void;
  private readonly terminalStateSeen = new Promise<void>((resolve) => {
    this.resolveTerminalState = resolve;
  });

  private constructor(
    private readonly server: Server,
    private readonly token: string,
    private readonly openUrl: OpenUrl,
  ) {}

  static async start(options: { openUrl?: OpenUrl } = {}): Promise<BrowserQrDisplay> {
    let server: Server | undefined;
    try {
      const token = randomBytes(32).toString("base64url");
      server = createServer();
      const display = new BrowserQrDisplay(server, token, options.openUrl ?? openLocalBrowser);
      server.on("request", (request, response) => display.respond(request, response));
      server.on("clientError", (_error, socket) => socket.destroy());
      server.requestTimeout = 5_000;
      server.headersTimeout = 5_000;
      server.keepAliveTimeout = 1_000;
      server.maxRequestsPerSocket = 20;
      await listen(server);
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing loopback address.");
      display.origin = `http://127.0.0.1:${address.port}`;
      server.unref();
      return display;
    } catch {
      try {
        server?.close();
      } catch {
        // The listener may not have started.
      }
      throw unavailable();
    }
  }

  async show(payload: string): Promise<BrowserQrResult> {
    if (this.closed || this.phase !== "pairing") throw unavailable();
    const update = this.updates.then(() => this.showNow(payload));
    this.updates = update.then(() => undefined, () => undefined);
    return update;
  }

  async pairingAccepted(): Promise<void> {
    if (this.closed || this.phase !== "pairing") return;
    this.phase = "finalizing";
    this.clearPng();
  }

  async finish(): Promise<void> {
    if (this.closed) return;
    this.phase = "linked";
    this.clearPng();
    const pageWasShown = this.browserAttempted;
    await this.updates;
    if (pageWasShown) await Promise.race([this.terminalStateSeen, delay(1_500)]);
    await this.close();
  }

  async fail(): Promise<void> {
    if (this.closed) return;
    this.phase = "failed";
    this.clearPng();
    const pageWasShown = this.browserAttempted;
    await this.updates;
    if (pageWasShown) await Promise.race([this.terminalStateSeen, delay(1_500)]);
    await this.close();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearPng();
    await this.updates;
    this.server.closeIdleConnections();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private async showNow(payload: string): Promise<BrowserQrResult> {
    let next: Buffer;
    try {
      next = await QRCode.toBuffer(payload, {
        type: "png",
        errorCorrectionLevel: "low",
        margin: 4,
        scale: 8,
        color: { dark: "#000000ff", light: "#ffffffff" },
      });
    } catch {
      throw unavailable();
    }
    if (this.closed || this.phase !== "pairing") {
      next.fill(0);
      throw unavailable();
    }
    this.png?.fill(0);
    this.png = next;
    this.version += 1;

    const url = `${this.origin}/${this.token}/`;
    if (!this.browserAttempted) {
      this.browserAttempted = true;
      this.browserOpened = await Promise.resolve()
        .then(() => this.openUrl(url))
        .catch(() => false);
    }
    return { url, browserOpened: this.browserOpened };
  }

  private respond(request: IncomingMessage, response: ServerResponse): void {
    applyPrivateHeaders(response);
    if (this.closed || request.socket.remoteAddress !== "127.0.0.1" ||
        request.headers.host !== this.origin.slice("http://".length)) {
      sendText(response, 404, "Not found.");
      return;
    }
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", this.origin).pathname;
    } catch {
      sendText(response, 404, "Not found.");
      return;
    }
    const pagePath = `/${this.token}/`;
    const pngPath = `/${this.token}/qr.png`;
    const statePath = `/${this.token}/state.json`;
    const scriptPath = `/${this.token}/poll.js`;
    if (![pagePath, pngPath, statePath, scriptPath].includes(pathname)) {
      sendText(response, 404, "Not found.");
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      sendText(response, 405, "Method not allowed.");
      return;
    }
    if (pathname === pagePath) {
      this.sendPage(request, response);
      return;
    }
    if (pathname === pngPath) {
      this.sendPng(request, response);
      return;
    }
    if (pathname === statePath) {
      this.sendState(request, response);
      return;
    }
    this.sendScript(request, response);
  }

  private sendPage(request: IncomingMessage, response: ServerResponse): void {
    const html = Buffer.from(renderPairingPage(this.version, this.phase), "utf8");
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Content-Length", html.byteLength);
    if (this.phase === "linked" || this.phase === "failed") {
      response.once("finish", this.resolveTerminalState);
    }
    if (request.method === "HEAD") response.end();
    else response.end(html);
  }

  private sendPng(request: IncomingMessage, response: ServerResponse): void {
    if (!this.png) {
      sendText(response, 503, "QR is not ready.");
      return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", "image/png");
    response.setHeader("Content-Length", this.png.byteLength);
    response.setHeader("X-Safe-WhatsApp-QR-Version", this.version);
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    const snapshot = Buffer.from(this.png);
    let wiped = false;
    const wipe = () => {
      if (wiped) return;
      wiped = true;
      snapshot.fill(0);
    };
    response.once("finish", wipe);
    response.once("close", wipe);
    response.end(snapshot);
  }

  private sendState(request: IncomingMessage, response: ServerResponse): void {
    const body = Buffer.from(JSON.stringify({
      phase: this.phase,
      version: this.version,
    }), "utf8");
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Content-Length", body.byteLength);
    if (this.phase === "linked" || this.phase === "failed") {
      response.once("finish", this.resolveTerminalState);
    }
    if (request.method === "HEAD") response.end();
    else response.end(body);
  }

  private sendScript(request: IncomingMessage, response: ServerResponse): void {
    const body = Buffer.from(PAIRING_POLL_SCRIPT, "utf8");
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/javascript; charset=utf-8");
    response.setHeader("Content-Length", body.byteLength);
    if (request.method === "HEAD") response.end();
    else response.end(body);
  }

  private clearPng(): void {
    this.png?.fill(0);
    this.png = undefined;
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
  });
}

function applyPrivateHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Expires", "0");
  response.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function sendText(response: ServerResponse, status: number, body: string): void {
  const bytes = Buffer.from(body, "utf8");
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Content-Length", bytes.byteLength);
  response.end(bytes);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function unavailable(): SafeWhatsAppError {
  return new SafeWhatsAppError(
    "The private local QR page could not be started. Retry from a normal desktop terminal.",
    "qr_display_unavailable",
  );
}
