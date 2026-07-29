// Agent context note: Defines the narrow, injectable contracts for privacy-conscious link-preview fetching. Tests: test/link-preview.test.mjs. Keep browser-facing cards free of remote image URLs and keep production transport pinning observable to deterministic tests; update this note after meaningful behavior changes.

export interface LinkPreviewCard {
  requestedUrl: string;
  finalUrl: string;
  title: string;
  description?: string;
  jpegThumbnail?: Uint8Array;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface LinkPreviewHttpRequest {
  url: URL;
  pinnedAddress: ResolvedAddress;
  headers: Readonly<Record<string, string>>;
  signal: AbortSignal;
}

export interface LinkPreviewHttpResponse {
  statusCode: number;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  body: AsyncIterable<Uint8Array>;
  dispose?(): void;
}

export interface LinkPreviewDependencies {
  resolve(hostname: string, signal: AbortSignal): Promise<readonly ResolvedAddress[]>;
  request(request: LinkPreviewHttpRequest): Promise<LinkPreviewHttpResponse>;
  sanitizeImage(bytes: Uint8Array): Promise<Uint8Array | undefined>;
}

export interface LinkPreviewFetchOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  dependencies?: Partial<LinkPreviewDependencies>;
}
