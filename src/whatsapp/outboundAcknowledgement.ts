// Agent context note: Sends one exact-ID WhatsApp message and classifies its raw server acknowledgement without retrying. Tests: test/outbound-acknowledgement.test.mjs. Keep the waiter registered before the write, persist only sanitized rejection codes, and update this note after meaningful changes.
import type { BinaryNode, WAMessage } from "baileys";
import type { WhatsAppSocket } from "./socketTypes.js";

export type OutboundAcknowledgement =
  | { outcome: "accepted" }
  | { outcome: "rejected"; errorCode: string }
  | { outcome: "uncertain" };

export type OutboundAttempt = OutboundAcknowledgement & {
  messageId: string;
  message?: WAMessage;
};

export async function sendAwaitingAcknowledgement(
  socket: Pick<WhatsAppSocket, "sendMessage" | "waitForMessage">,
  input: {
    jid: string;
    content: unknown;
    messageId: string;
    timeoutMs: number;
    quoted?: WAMessage;
  },
): Promise<OutboundAttempt> {
  const acknowledgement = socket.waitForMessage(
    input.messageId,
    input.timeoutMs,
  ).then(
    (node) => classifyAcknowledgement(node, input.messageId),
    () => ({ outcome: "uncertain" }) as const,
  );
  let message: WAMessage | undefined;
  const sendFailure = socket.sendMessage(input.jid, input.content, {
    messageId: input.messageId,
    ...(input.quoted ? { quoted: input.quoted } : {}),
  }).then((sent) => {
    message = sent;
    return sent?.key.id === input.messageId
      ? new Promise<never>(() => undefined)
      : ({ outcome: "uncertain" } as const);
  }, () => ({ outcome: "uncertain" }) as const);
  const result = await boundedAcknowledgement(Promise.race([
    acknowledgement,
    sendFailure,
  ]), input.timeoutMs);
  return {
    ...result,
    messageId: input.messageId,
    ...(message ? { message } : {}),
  };
}

async function boundedAcknowledgement(
  acknowledgement: Promise<OutboundAcknowledgement>,
  timeoutMs: number,
): Promise<OutboundAcknowledgement> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      acknowledgement,
      new Promise<OutboundAcknowledgement>((resolve) => {
        timer = setTimeout(() => resolve({ outcome: "uncertain" }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function classifyAcknowledgement(
  node: BinaryNode | undefined,
  messageId: string,
): OutboundAcknowledgement {
  if (!node || node.tag !== "ack" || node.attrs.class !== "message" ||
      node.attrs.id !== messageId) {
    return { outcome: "uncertain" };
  }
  return node.attrs.error
    ? { outcome: "rejected", errorCode: rejectionErrorCode(node.attrs.error) }
    : { outcome: "accepted" };
}

export function rejectionErrorCode(raw: unknown): string {
  return typeof raw === "string" && /^\d{1,6}$/u.test(raw)
    ? `whatsapp_rejected_${raw}`
    : "whatsapp_rejected";
}
