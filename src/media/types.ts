// Agent context note: Shared contracts for bounded streamed downloads and ID-bound outbound snapshots. Tests: test/media.test.mjs and test/send-service.test.mjs. Keep streaming limits, snapshot identity, and view-once refusal explicit; update this note after meaningful behavior changes.
export type OutboundMediaKind = "image" | "audio" | "video" | "document";

export interface OutboundMediaSnapshot {
  pendingId: string;
  path: string;
  originalName: string;
  sha256: string;
  size: number;
  mimeType: string;
  kind: OutboundMediaKind;
}

export interface OutboundMediaContent {
  bytes: Uint8Array;
  originalName: string;
  sha256: string;
  size: number;
  mimeType: string;
  kind: OutboundMediaKind;
}

export interface RetainedMediaDescriptor {
  messageId: string;
  fileName?: string;
  mimeType?: string;
  size?: number;
  mediaType: "image" | "sticker" | "audio" | "video" | "document";
  deleted?: boolean;
  expired?: boolean;
  viewOnce?: boolean;
}

export interface InboundMediaSource {
  describe(messageId: string): Promise<RetainedMediaDescriptor | undefined>;
  download(messageId: string, maxBytes: number): Promise<AsyncIterable<Uint8Array>>;
}

export interface InboundMediaMetadata {
  messageId: string;
  fileName?: string;
  mimeType: string;
  size: number;
  mediaType: RetainedMediaDescriptor["mediaType"];
  sha256: string;
}

export type InboundMediaResult =
  | {
      delivery: "inline";
      metadata: InboundMediaMetadata;
      bytes: Uint8Array;
    }
  | {
      delivery: "resource";
      metadata: InboundMediaMetadata;
      uri: string;
    };
