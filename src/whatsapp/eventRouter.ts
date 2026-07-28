// Agent context note: Routes supported Baileys events into durable auth, identity, chat, and message state, completing sync only after the final recent-history chunk is ingested, with an awaitable credential barrier for pairing restarts. Tests: test/core-event-router.test.mjs. Pending notifications and isLatest are not history completion; do not add presence/read-receipt side effects; update this note after meaningful changes.
import {
  proto,
  type AuthenticationCreds,
  type GroupMetadata,
  type GroupParticipant,
  type WAMessage,
  type WAMessageKey,
  type WAMessageUpdate,
} from "baileys";
import type { SqliteAuthState } from "../auth/sqliteAuthState.js";
import type { MessageStore } from "../messages/messageStore.js";
import type { ConnectionUpdate, SocketEvents } from "./socketTypes.js";

export interface EventRouterHooks {
  onConnectionUpdate?(update: ConnectionUpdate): void;
  onHistoryComplete?(): void;
  onPersistenceError?(error: unknown): void;
}

export class EventRouter {
  private credentialPersistence = Promise.resolve();
  private credentialFailure?: unknown;

  constructor(
    private readonly auth: SqliteAuthState,
    private readonly messages: MessageStore,
  ) {}

  async waitForCredentialPersistence(): Promise<void> {
    let pending: Promise<void>;
    do {
      pending = this.credentialPersistence;
      await pending;
    } while (pending !== this.credentialPersistence);
    if (this.credentialFailure) throw this.credentialFailure;
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
      if (
        history.syncType === proto.HistorySync.HistorySyncType.RECENT &&
        history.progress === 100
      ) hooks.onHistoryComplete?.();
    });
    on<{ messages: WAMessage[]; type: string }>("messages.upsert", (update) => {
      this.messages.ingestUpsert(update);
    });
    on<WAMessageUpdate[]>("messages.update", (updates) => {
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
