// Agent context note: Owns cancellable lazy single-flight sockets, credential-safe pairing restarts, bounded sync/retries, awaited shutdown, idle shutdown, and explicit remote logout. Tests: test/core-session-client.test.mjs. Awaited connection/sync deadlines must keep Node alive; only the background idle timer is unreferenced; update this note after meaningful changes.
import { SafeWhatsAppError } from "../errors.js";
import type { EventRouter } from "./eventRouter.js";
import type { ConnectionUpdate, SocketFactory, WhatsAppSocket } from "./socketTypes.js";

export type SyncCompleteness = "complete" | "partial";
export interface SessionResult<T> { value: T; syncCompleteness: SyncCompleteness }
export interface SessionSnapshot {
  connected: boolean;
  connecting: boolean;
  syncCompleteness?: SyncCompleteness;
  failureCode?: string;
}

export interface SessionOptions {
  syncTimeoutMs: number;
  connectionTimeoutMs?: number;
  idleTimeoutMs: number;
  maxRetries?: number;
  connectionBudgetMs?: number;
  onQr?(qr: string): void;
  onPairingAccepted?(): void;
  isRetryable?(error: unknown): boolean;
}

interface ActiveSession {
  socket: WhatsAppSocket;
  end: (error?: Error) => Promise<void>;
  detach: () => void;
  complete: boolean;
  syncWindowFinished: boolean;
  syncSignal: Promise<void>;
  resolveSync: () => void;
  failure?: SafeWhatsAppError;
  failureCause?: unknown;
  failureSignal: Promise<never>;
  rejectFailure: (reason?: unknown) => void;
  syncDeadline: number;
}

export class SessionManager {
  private active?: ActiveSession;
  private opening?: Promise<ActiveSession>;
  private openingCancellation?: ReturnType<typeof cancellation>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private operations = 0;
  private generation = 0;
  private lastFailureCode?: string;

  constructor(
    private readonly factory: SocketFactory,
    private readonly router: EventRouter,
    private readonly options: SessionOptions,
  ) {}

  async connect(): Promise<SyncCompleteness> {
    const active = await this.getActive();
    const completeness = await this.waitForSync(active);
    await this.awaitCredentialPersistence();
    this.scheduleIdle();
    return completeness;
  }

  async run<T>(operation: (socket: WhatsAppSocket) => Promise<T>): Promise<SessionResult<T>> {
    this.operations += 1;
    this.clearIdle();
    try {
      const active = await this.getActive();
      const syncCompleteness = await this.waitForSync(active);
      await this.awaitCredentialPersistence();
      if (active.failure) throw active.failure;
      const value = await Promise.race([operation(active.socket), active.failureSignal]);
      return { value, syncCompleteness };
    } finally {
      this.operations -= 1;
      this.scheduleIdle();
    }
  }

  snapshot(): SessionSnapshot {
    return {
      connected: Boolean(this.active),
      connecting: Boolean(this.opening),
      ...(this.active
        ? { syncCompleteness: this.active.complete ? "complete" : "partial" as const }
        : {}),
      ...(this.lastFailureCode ? { failureCode: this.lastFailureCode } : {}),
    };
  }

  async disconnect(): Promise<void> {
    this.clearIdle();
    this.generation += 1;
    const opening = this.opening;
    this.openingCancellation?.reject(connectionCancelled());
    const active = this.active;
    this.active = undefined;
    let closing = Promise.resolve();
    if (active) {
      active.detach();
      closing = active.end();
    }
    let closingError: unknown;
    try {
      await Promise.all([closing, opening?.catch(() => undefined)]);
    } catch (error) {
      closingError = error;
    }
    await this.awaitCredentialPersistence();
    if (closingError) throw closingError;
  }

  async unlink(): Promise<void> {
    this.clearIdle();
    const active = await this.getActive();
    this.active = undefined;
    await this.awaitCredentialPersistence();
    active.detach();
    try {
      await active.socket.logout();
    } catch (error) {
      await active.end().catch(() => undefined);
      throw error;
    }
  }

  private async getActive(): Promise<ActiveSession> {
    if (this.active) return this.active;
    if (!this.opening) {
      const generation = this.generation;
      const cancelled = cancellation();
      this.openingCancellation = cancelled;
      const opening = this.openWithRetries(generation, cancelled.promise);
      let tracked!: Promise<ActiveSession>;
      tracked = opening.finally(() => {
        if (this.opening === tracked) {
          this.opening = undefined;
          if (this.openingCancellation === cancelled) this.openingCancellation = undefined;
        }
      });
      this.opening = tracked;
    }
    return this.opening;
  }

  private async openWithRetries(
    generation: number,
    cancelled: Promise<never>,
  ): Promise<ActiveSession> {
    const maxRetries = this.options.maxRetries ?? 3;
    const deadline = Date.now() + (this.options.connectionBudgetMs ?? 50_000);
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const active = await this.openOnce(Math.min(
          this.options.connectionTimeoutMs ?? this.options.syncTimeoutMs,
          remaining,
        ), deadline, cancelled);
        if (active.failure) throw active.failureCause ?? active.failure;
        if (generation !== this.generation) {
          active.detach();
          await active.end().catch(() => undefined);
          throw new SafeWhatsAppError("WhatsApp connection was cancelled.", "connection_cancelled");
        }
        this.lastFailureCode = undefined;
        this.active = active;
        return active;
      } catch (error) {
        lastError = error;
        if (attempt === maxRetries || !this.retryable(error)) break;
        await this.awaitCredentialPersistence();
        await Promise.race([
          delay(Math.min(1_000, 100 * 2 ** attempt, Math.max(0, deadline - Date.now()))),
          cancelled,
        ]);
      }
    }
    if (lastError instanceof SafeWhatsAppError) throw lastError;
    throw new SafeWhatsAppError(
      "WhatsApp could not connect after bounded retries.",
      "connection_failed",
    );
  }

  private async openOnce(
    connectionTimeoutMs: number,
    syncDeadline: number,
    cancelled: Promise<never>,
  ): Promise<ActiveSession> {
    const creating = this.factory.create();
    let socket: WhatsAppSocket;
    try {
      socket = await Promise.race([creating, cancelled]);
    } catch (error) {
      void creating.then(
        (created) => Promise.resolve(created.end()).catch(() => undefined),
        () => undefined,
      );
      throw error;
    }
    const opened = deferred<void>();
    const sync = deferred<void>();
    const failure = deferred<never>();
    void failure.promise.catch(() => undefined);
    let closedError: unknown;
    const active: ActiveSession = {
      socket,
      end: socketEnder(socket),
      detach: () => undefined,
      complete: false,
      syncWindowFinished: false,
      syncSignal: sync.promise,
      resolveSync: sync.resolve,
      failureSignal: failure.promise,
      rejectFailure: failure.reject,
      syncDeadline,
    };
    active.detach = this.router.attach(socket.events, {
      onHistoryComplete: () => {
        active.complete = true;
        active.syncWindowFinished = true;
        sync.resolve();
      },
      onConnectionUpdate: (update) => {
        if (update.qr) this.options.onQr?.(update.qr);
        if (update.isNewLogin) this.options.onPairingAccepted?.();
        if (update.connection === "open") opened.resolve();
        if (update.connection === "close") {
          closedError = update.lastDisconnect?.error;
          const safeError = new SafeWhatsAppError(
            "WhatsApp connection closed before the operation completed.",
            "connection_closed",
          );
          active.failure = safeError;
          active.failureCause = closedError;
          active.rejectFailure(safeError);
          opened.reject(closedError ?? new Error("WhatsApp connection closed."));
          if (this.active === active) {
            this.active = undefined;
            active.detach();
          }
        }
      },
      onPersistenceError: () => {
        const error = new SafeWhatsAppError(
          "WhatsApp credentials could not be persisted safely.",
          "auth_persistence_failed",
        );
        active.failure = error;
        active.rejectFailure(error);
        this.lastFailureCode = error.code;
        opened.reject(error);
        sync.resolve();
        if (this.active === active) {
          this.active = undefined;
          active.detach();
          void active.end(error).catch(() => undefined);
        }
      },
    });
    try {
      await withTimeout(
        Promise.race([opened.promise, cancelled]),
        connectionTimeoutMs,
        "WhatsApp connection timed out.",
      );
      if (closedError) throw closedError;
      if (active.failure) throw active.failure;
      return active;
    } catch (error) {
      active.detach();
      await active.end().catch(() => undefined);
      throw closedError ?? error;
    }
  }

  private async waitForSync(active: ActiveSession): Promise<SyncCompleteness> {
    if (active.failure) throw active.failure;
    if (active.complete) return "complete";
    if (!active.syncWindowFinished) {
      const completed = await Promise.race([
        raceTimeout(
          active.syncSignal,
          Math.max(0, Math.min(this.options.syncTimeoutMs, active.syncDeadline - Date.now())),
        ),
        active.failureSignal,
      ]);
      active.syncWindowFinished = true;
      if (completed) active.complete = true;
    }
    if (active.failure) throw active.failure;
    return active.complete ? "complete" : "partial";
  }

  private retryable(error: unknown): boolean {
    if (this.options.isRetryable) return this.options.isRetryable(error);
    if (error instanceof SafeWhatsAppError && [
      "auth_persistence_failed",
      "connection_cancelled",
    ].includes(error.code)) return false;
    const status = statusCode(error);
    return status === undefined || ![401, 403, 440].includes(status);
  }

  private async awaitCredentialPersistence(): Promise<void> {
    try {
      await this.router.waitForCredentialPersistence();
    } catch {
      const error = new SafeWhatsAppError(
        "WhatsApp credentials could not be persisted safely.",
        "auth_persistence_failed",
      );
      this.lastFailureCode = error.code;
      throw error;
    }
  }

  private scheduleIdle(): void {
    this.clearIdle();
    if (!this.active || this.operations > 0) return;
    this.idleTimer = setTimeout(() => {
      void this.disconnect().catch(() => undefined);
    }, this.options.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}

function socketEnder(socket: WhatsAppSocket): (error?: Error) => Promise<void> {
  let ending: Promise<void> | undefined;
  return (error?: Error) => {
    ending ??= Promise.resolve().then(() => socket.end(error));
    return ending;
  };
}

function cancellation(): {
  promise: Promise<never>;
  reject: (reason?: unknown) => void;
} {
  const cancelled = deferred<never>();
  void cancelled.promise.catch(() => undefined);
  return { promise: cancelled.promise, reject: cancelled.reject };
}

function connectionCancelled(): SafeWhatsAppError {
  return new SafeWhatsAppError("WhatsApp connection was cancelled.", "connection_cancelled");
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

async function raceTimeout(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  if (milliseconds <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { statusCode?: unknown; output?: { statusCode?: unknown } };
  const value = candidate.output?.statusCode ?? candidate.statusCode;
  return typeof value === "number" ? value : undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
