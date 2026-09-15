// Agent context note: Routes Baileys events into durable auth/chat state, journals exact-ID late send rejections before reporting them, and exposes recent/full history progress to the session manager. Tests: test/core-event-router.test.mjs and test/message-resync.test.mjs. Pending notifications are not completion; do not add presence/read-receipt effects or treat send echoes as authority.
import {
  proto,
  WAMessageStatus,
  type AuthenticationCreds,
  type GroupMetadata,
  type GroupParticipant,
  type WAMessage,
  type WAMessageKey,
  type WAMessageUpdate,
} from "baileys";
import type { SqliteAuthState } from "../auth/sqliteAuthState.js";
import type { MessageStore } from "../messages/messageStore.js";
import type { OutboundFailureJournal } from "../replies/outboundFailureJournal.js";
import type { ConnectionUpdate, SocketEvents } from "./socketTypes.js";
import { rejectionErrorCode } from "./outboundAcknowledgement.js";

export interface EventRouterHooks {
  onConnectionUpdate?(update: ConnectionUpdate): void;
  onHistoryComplete?(): void;
  onFullHistoryProgress?(progress?: number | null): void;
  onPersistenceError?(error: unknown): void;
}

export class EventRouter {
  private credentialPersistence = Promise.resolve();
  private credentialFailure?: unknown;
  private readonly outboundRejectionListeners = new Set<(
    rejection: { messageId: string; errorCode: string },
  ) => void | Promise<void>>();

  constructor(
    private readonly auth: SqliteAuthState,
    private readonly messages: MessageStore,
    private readonly outboundFailures?: OutboundFailureJournal,
  ) {}

  async waitForCredentialPersistence(): Promise<void> {
    let pending: Promise<void>;
    do {
      pending = this.credentialPersistence;
      await pending;
    } while (pending !== this.credentialPersistence);
    if (this.credentialFailure) throw this.credentialFailure;
  }

  onOutboundRejection(
    listener: (rejection: { messageId: string; errorCode: string }) => void | Promise<void>,
  ): () => void {
    this.outboundRejectionListeners.add(listener);
    return () => this.outboundRejectionListeners.delete(listener);
  }

  attach(events: SocketEvents, hooks: EventRouterHooks = {}): () => void {
    const listeners: [string, (value: never) => void][] = [];
    const report = (error: unknown) => {
      try { hooks.onPersistenceError?.(error); } catch { /* Never throw from a Baileys emitter. */ }
    };
    const on = <T>(event: string, listener: (value: T) => void | Promise<void>) => {
      const wrapped = ((value: T) => {
        try {
          const result = listener(value);
          if (result instanceof Promise) void result.catch(report);
        } catch (error) {
          report(error);
        }
      }) as (value: never) => void;
      events.on(event, wrapped);
      listeners.push([event, wrapped]);
    };

    on<Partial<AuthenticationCreds>>("creds.update", (update) => {
      const write = this.credentialPersistence.then(() => this.auth.saveCreds(update));
      this.credentialPersistence = write.then(
        () => undefined,
        (error: unknown) => {
          this.credentialFailure ??= error;
          report(error);
        },
      );
    });
    on<ConnectionUpdate>("connection.update", (update) => {
      hooks.onConnectionUpdate?.(update);
    });
    on<{
      chats: Parameters<MessageStore["upsertChats"]>[0];
      contacts: Parameters<MessageStore["upsertContacts"]>[0];
      messages: WAMessage[];
      lidPnMappings?: { lid: string; pn: string }[];
      isLatest?: boolean;
      progress?: number | null;
      syncType?: proto.HistorySync.HistorySyncType | null;
    }>("messaging-history.set", (history) => {
      this.messages.ingestHistory(history);
      if (history.syncType === proto.HistorySync.HistorySyncType.FULL) {
        hooks.onFullHistoryProgress?.(history.progress);
      }
      if (
        history.syncType === proto.HistorySync.HistorySyncType.RECENT &&
        history.progress === 100
      ) hooks.onHistoryComplete?.();
    });
    on<{ messages: WAMessage[]; type: string }>("messages.upsert", (update) => {
      this.messages.ingestUpsert(update);
    });
    on<WAMessageUpdate[]>("messages.update", (updates) => {
      for (const item of updates) {
        if (item.key.fromMe !== true || typeof item.key.id !== "string" ||
            item.update.status !== WAMessageStatus.ERROR) continue;
        const rejection = {
          messageId: item.key.id,
          errorCode: rejectionErrorCode(item.update.messageStubParameters?.[0]),
        };
        this.outboundFailures?.record(rejection.messageId, rejection.errorCode);
        for (const listener of this.outboundRejectionListeners) {
          try {
            const result = listener(rejection);
            if (result instanceof Promise) void result.catch(() => undefined);
          } catch { /* A late transport signal must never escape Baileys' emitter. */ }
        }
      }
      this.messages.applyUpdates(updates);
    });
    on<{ keys: WAMessageKey[] } | { jid: string; all: true }>("messages.delete", (update) => {
      this.messages.applyDeletes(update);
    });
    on<Parameters<MessageStore["upsertChats"]>[0]>("chats.upsert", (chats) => {
      this.messages.upsertChats(chats);
    });
    on<Parameters<MessageStore["upsertChats"]>[0]>("chats.update", (chats) => {
      this.messages.upsertChats(chats);
    });
    on<string[]>("chats.delete", (jids) => this.messages.deleteChats(jids));
    on<Parameters<MessageStore["upsertContacts"]>[0]>("contacts.upsert", (contacts) => {
      this.messages.upsertContacts(contacts);
    });
    on<Parameters<MessageStore["upsertContacts"]>[0]>("contacts.update", (contacts) => {
      this.messages.upsertContacts(contacts);
    });
    on<{ lid: string; pn: string }>("lid-mapping.update", ({ lid, pn }) => {
      this.messages.linkLidMapping(lid, pn);
    });
    on<GroupMetadata[]>("groups.upsert", (groups) => this.messages.upsertGroups(groups));
    on<Partial<GroupMetadata>[]>("groups.update", (groups) => this.messages.upsertGroups(groups));
    on<{ id: string; participants: GroupParticipant[]; action: string }>(
      "group-participants.update",
      (update) => {
        for (const participant of update.participants) {
          const metadata = participant as GroupParticipant & { phoneNumber?: string; lid?: string };
          const paired = metadata.phoneNumber ?? metadata.lid;
          if (metadata.id && paired) {
            this.messages.linkUserAliases(metadata.id, paired);
          }
        }
      },
    );
    return () => {
      for (const [event, listener] of listeners) events.off(event, listener);
    };
  }
}
