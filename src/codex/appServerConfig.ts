// Agent context note: Provides a bounded JSONL client for Codex app-server config reads and atomic writes. Tests: test/codex-app-server.test.mjs. Keep errors sanitized, require the initialize handshake, and never expose app-server stderr or config contents; update this note after meaningful changes.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import process from "node:process";
import { APP_NAME, PACKAGE_NAME, VERSION } from "../constants.js";
import { SafeWhatsAppError } from "../errors.js";

const MAX_LINE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

interface RpcEnvelope {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; data?: unknown };
}

export interface CodexAppServerOptions {
  command?: string;
  args?: string[];
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
}

export interface ConfigEdit {
  keyPath: string;
  value: unknown;
  mergeStrategy: "replace" | "upsert";
}

export interface ConfigBatchWriteParams {
  edits: ConfigEdit[];
  filePath: string;
  expectedVersion: string;
  reloadUserConfig: boolean;
}

export class CodexConfigRpcError extends Error {
  constructor(
    readonly rpcCode: number | undefined,
    readonly dataCode: string | undefined,
  ) {
    super("Codex rejected the configuration request.");
    this.name = "CodexConfigRpcError";
  }
}

export class CodexAppServerConfigClient {
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, PendingRequest>();
  private failed = false;
  private closing = false;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly requestTimeoutMs: number,
  ) {
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    child.stderr.on("data", () => undefined);
    child.once("error", (error) => this.fail(error));
    child.once("exit", () => {
      if (!this.closing) this.fail(new Error("Codex app-server exited."));
    });
  }

  static async connect(options: CodexAppServerOptions): Promise<CodexAppServerConfigClient> {
    const child = spawn(
      options.command ?? "codex",
      options.args ?? ["app-server", "--listen", "stdio://"],
      {
        cwd: options.cwd,
        env: options.environment ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const client = new CodexAppServerConfigClient(
      child,
      options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    );
    try {
      await client.request("initialize", {
        clientInfo: { name: PACKAGE_NAME, title: APP_NAME, version: VERSION },
        capabilities: { experimentalApi: true },
      });
      client.notify("initialized", {});
      return client;
    } catch (error) {
      await client.close();
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new SafeWhatsAppError(
          "Codex CLI was not found. Install or update Codex, then retry setup.",
          "codex_cli_not_found",
        );
      }
      if (error instanceof SafeWhatsAppError) throw error;
      throw unavailable();
    }
  }

  readConfig(): Promise<unknown> {
    return this.request("config/read", { includeLayers: true });
  }

  batchWrite(params: ConfigBatchWriteParams): Promise<unknown> {
    return this.request("config/batchWrite", params);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.fail(unavailable());
    this.child.stdin.end();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => this.child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 500)),
    ]);
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.failed || this.closing || this.pending.size >= 8) return Promise.reject(unavailable());
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(unavailable());
      }, this.requestTimeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params }, id);
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.failed && !this.closing) this.write({ method, params });
  }

  private write(message: unknown, requestId?: number): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (!error || requestId === undefined) return;
      const pending = this.pending.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.reject(error);
    });
  }

  private onData(chunk: Buffer): void {
    if (this.failed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.byteLength > MAX_LINE_BYTES) {
      this.fail(unavailable());
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.byteLength === 0) continue;
      this.onLine(line);
      if (this.failed) return;
    }
  }

  private onLine(line: Buffer): void {
    let envelope: RpcEnvelope;
    try {
      envelope = JSON.parse(line.toString("utf8")) as RpcEnvelope;
    } catch {
      this.fail(unavailable());
      return;
    }
    if (!Number.isSafeInteger(envelope.id)) return;
    const id = envelope.id as number;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (envelope.error) {
      const data = isRecord(envelope.error.data) ? envelope.error.data : undefined;
      pending.reject(new CodexConfigRpcError(
        typeof envelope.error.code === "number" ? envelope.error.code : undefined,
        typeof data?.config_write_error_code === "string"
          ? data.config_write_error_code
          : undefined,
      ));
      return;
    }
    pending.resolve(envelope.result);
  }

  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function unavailable(): SafeWhatsAppError {
  return new SafeWhatsAppError(
    "Codex configuration is unavailable. Update Codex and retry setup.",
    "codex_config_unavailable",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
