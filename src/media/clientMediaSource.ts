// Agent context note: Adapts the production WhatsApp client’s retained-media API to the bounded inbound media service. Tests: test/media.test.mjs and test/core-session-client.test.mjs. Preserve descriptor field mapping and always forward the service byte cap; update this note after meaningful behavior changes.
import type { InboundMediaSource, RetainedMediaDescriptor } from "./types.js";

export interface RetainedMediaClient {
  getRetainedMediaDescriptor(messageId: string): {
    messageId: string;
    kind: RetainedMediaDescriptor["mediaType"];
    mime?: string;
    filename?: string;
    size?: number;
  } | undefined;
  downloadRetainedMedia(messageId: string, maxBytes: number): Promise<AsyncIterable<Uint8Array>>;
}

export class ClientMediaSource implements InboundMediaSource {
  constructor(private readonly client: RetainedMediaClient) {}

  async describe(messageId: string): Promise<RetainedMediaDescriptor | undefined> {
    const descriptor = this.client.getRetainedMediaDescriptor(messageId);
    return descriptor ? {
      messageId: descriptor.messageId,
      mediaType: descriptor.kind,
      mimeType: descriptor.mime,
      fileName: descriptor.filename,
      size: descriptor.size,
    } : undefined;
  }

  download(messageId: string, maxBytes: number): Promise<AsyncIterable<Uint8Array>> {
    return this.client.downloadRetainedMedia(messageId, maxBytes);
  }
}
