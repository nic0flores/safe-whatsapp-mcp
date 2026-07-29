// Agent context note: Runs the singleton loopback broker that owns application state, MCP transports, and browser-review leases. Tests: broker integration, review-manager, and package smoke. Bind only 127.0.0.1, keep open reviews alive after proxies detach, drain in-flight work before closing, and never log WhatsApp out during broker shutdown.
import { randomUUID } from "node:crypto";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SafeWhatsAppApplication } from "../application.js";
import { VERSION } from "../constants.js";
import { createWhatsAppMcpServer } from "../mcp/server.js";
import { StatePaths } from "../storage/paths.js";
import {
  removeBrokerDescriptor,
  writeBrokerDescriptor,
} from "./descriptor.js";
import { BrokerActivity, trackBrokerServices } from "./activity.js";
import {
  authenticateBrokerSocket,
  BROKER_HOST,
  BROKER_PROTOCOL,
  newBrokerSecret,
  policyForConfig,
  type BrokerDescriptor,
} from "./protocol.js";

const DEFAULT_BOOTSTRAP_IDLE_MS = 10_000;
const DEFAULT_LAST_CLIENT_IDLE_MS = 1_000;
const DEFAULT_MAX_CLIENTS = 32;
const MCP_REQUEST_MAX_BYTES = 2 * 1024 * 1024;

interface BrokerSession {
  socket: Socket;
  close(): Promise<void>;
}

export interface LocalBrokerOptions {
  paths?: StatePaths;
  bootstrapIdleMs?: number;
  lastClientIdleMs?: number;
  maxClients?: number;
  parented?: boolean;
  onReady?(): void;
}

export async function runLocalBroker(options: LocalBrokerOptions = {}): Promise<void> {
  const paths = options.paths ?? new StatePaths();
  let parentDisconnected = options.parented === true && !process.connected;
  let stopRequested = false;
  let broker: LocalBroker | undefined;
  let application: SafeWhatsAppApplication | undefined;
  const releaseParentWatch = () => {
    process.off("disconnect", onParentDisconnect);
    process.channel?.unref();
  };
  const onParentDisconnect = () => {
    parentDisconnected = true;
    stopRequested = true;
    if (broker) void broker.stop().catch(() => undefined);
  };
  if (options.parented) process.once("disconnect", onParentDisconnect);
  if (parentDisconnected) {
    releaseParentWatch();
    return;
  }
  const onSignal = () => {
    stopRequested = true;
    void broker?.stop().catch(() => undefined);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    application = await SafeWhatsAppApplication.open({ paths });
    if (parentDisconnected || stopRequested) return;
    broker = new LocalBroker(application, {
      ...options,
      onReady: () => {
        releaseParentWatch();
        options.onReady?.();
      },
    });
    await broker.run();
  } finally {
    releaseParentWatch();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (broker) await broker.stop().catch(() => undefined);
    else await application?.close().catch(() => undefined);
  }
}

class LocalBroker {
  private readonly listener: Server;
  private readonly pending = new Set<Socket>();
  private readonly sessions = new Set<BrokerSession>();
  private readonly activity = new BrokerActivity();
  private readonly services;
  private readonly paths: StatePaths;
  private readonly bootstrapIdleMs: number;
  private readonly lastClientIdleMs: number;
  private readonly maxClients: number;
  private readonly onReady?: () => void;
  private descriptor?: BrokerDescriptor;
  private idleTimer?: NodeJS.Timeout;
  private stopping?: Promise<void>;
  private resolveDone!: () => void;
  private readonly done = new Promise<void>((resolve) => { this.resolveDone = resolve; });

  constructor(
    private readonly application: SafeWhatsAppApplication,
    options: LocalBrokerOptions,
  ) {
    this.paths = options.paths ?? application.paths;
    this.bootstrapIdleMs = options.bootstrapIdleMs ?? DEFAULT_BOOTSTRAP_IDLE_MS;
    this.lastClientIdleMs = options.lastClientIdleMs ?? DEFAULT_LAST_CLIENT_IDLE_MS;
    this.maxClients = options.maxClients ?? DEFAULT_MAX_CLIENTS;
    this.onReady = options.onReady;
    this.services = trackBrokerServices(application.services, this.activity);
    this.activity.onIdle = () => this.scheduleIdleShutdown();
    this.application.reviews.onIdle = () => this.scheduleIdleShutdown();
    this.listener = createServer(
      { pauseOnConnect: true },
      (socket) => { void this.accept(socket); },
    );
    this.listener.on("error", () => { void this.stop().catch(() => undefined); });
  }

  async run(): Promise<void> {
    try {
      if (this.stopping) return;
      await this.listen();
      if (this.stopping) return;
      const address = this.listener.address() as AddressInfo;
      const descriptor: BrokerDescriptor = {
        schema: 1,
        protocol: BROKER_PROTOCOL,
        packageVersion: VERSION,
        instanceId: randomUUID(),
        pid: process.pid,
        port: address.port,
        secret: newBrokerSecret(),
        createdAt: new Date().toISOString(),
        ...policyForConfig(this.application.config),
      };
      this.descriptor = descriptor;
      await writeBrokerDescriptor(this.paths, descriptor);
      if (this.stopping) {
        await removeBrokerDescriptor(this.paths, descriptor).catch(() => undefined);
        return;
      }
      this.onReady?.();
      this.scheduleIdleShutdown(this.bootstrapIdleMs);
      await this.done;
    } catch (error) {
      const wasStopping = Boolean(this.stopping);
      await this.stop();
      if (wasStopping) return;
      throw error;
    }
  }

  stop(): Promise<void> {
    this.stopping ??= this.stopOnce();
    return this.stopping;
  }

  private async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.listener.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.listener.off("error", onError);
        resolve();
      };
      this.listener.once("error", onError);
      this.listener.once("listening", onListening);
      this.listener.listen({ host: BROKER_HOST, port: 0, exclusive: true });
    });
  }

  private async accept(socket: Socket): Promise<void> {
    socket.on("error", () => undefined);
    if (
      this.stopping ||
      socket.remoteAddress !== BROKER_HOST ||
      this.pending.size + this.sessions.size >= this.maxClients + 1 ||
      !this.descriptor
    ) {
      socket.destroy();
      return;
    }
    this.clearIdleTimer();
    this.pending.add(socket);
    socket.setNoDelay(true);
    try {
      const purpose = await authenticateBrokerSocket(socket, this.descriptor);
      if (this.stopping || socket.destroyed) return;
      this.pending.delete(socket);
      if (purpose === "shutdown") {
        socket.resume();
        socket.end();
        void this.stop().catch(() => undefined);
        return;
      }
      if (this.sessions.size >= this.maxClients) {
        socket.destroy();
        return;
      }
      await this.openSession(socket);
    } catch {
      socket.destroy();
    } finally {
      this.pending.delete(socket);
      this.scheduleIdleShutdown();
    }
  }

  private async openSession(socket: Socket): Promise<void> {
    const server = createWhatsAppMcpServer({ services: this.services });
    const transport = new StdioServerTransport(socket, socket, {
      maxBufferSize: MCP_REQUEST_MAX_BYTES,
    });
    let closing: Promise<void> | undefined;
    let session!: BrokerSession;
    const close = () => {
      closing ??= Promise.resolve().then(async () => {
        this.sessions.delete(session);
        await server.close().catch(() => undefined);
        socket.destroy();
        this.scheduleIdleShutdown();
      });
      return closing;
    };
    session = { socket, close };
    this.sessions.add(session);
    const onClose = () => { void close(); };
    socket.once("end", onClose);
    socket.once("close", onClose);
    socket.once("error", onClose);
    transport.onclose = onClose;
    server.server.onerror = () => undefined;
    try {
      await server.connect(transport);
      socket.resume();
    } catch (error) {
      await close();
      throw error;
    }
  }

  private scheduleIdleShutdown(delay = this.lastClientIdleMs): void {
    if (
      this.stopping ||
      this.pending.size > 0 ||
      this.sessions.size > 0 ||
      this.activity.count > 0 ||
      this.application.reviews.sessionCount > 0
    ) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (
        this.pending.size === 0 &&
        this.sessions.size === 0 &&
        this.activity.count === 0 &&
        this.application.reviews.sessionCount === 0
      ) void this.stop().catch(() => undefined);
    }, delay);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private async stopOnce(): Promise<void> {
    this.clearIdleTimer();
    const listenerClosed = this.closeListener();
    for (const socket of this.pending) socket.destroy();
    this.pending.clear();
    await Promise.all([...this.sessions].map((session) => session.close()));
    await listenerClosed;
    await this.activity.waitForIdle();
    try {
      if (this.descriptor) {
        await removeBrokerDescriptor(this.paths, this.descriptor).catch(() => undefined);
      }
    } finally {
      try {
        await this.application.close();
      } finally {
        this.resolveDone();
      }
    }
  }

  private closeListener(): Promise<void> {
    if (!this.listener.listening) return Promise.resolve();
    return new Promise((resolve) => {
      this.listener.close(() => resolve());
    });
  }
}
