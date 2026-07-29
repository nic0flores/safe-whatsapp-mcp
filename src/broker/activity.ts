// Agent context note: Tracks shared broker service operations so the last proxy cannot close SQLite or WhatsApp beneath an in-flight tool call. Tests: broker integration tests. Every exposed service promise must hold a lease through settlement, including failures and media-resource reads.
import type { WhatsAppMcpServices } from "../mcp/contracts.js";

export class BrokerActivity {
  private active = 0;
  private readonly idleWaiters = new Set<() => void>();
  onIdle?: () => void;

  get count(): number {
    return this.active;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      if (this.active === 0) {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
        this.onIdle?.();
      }
    }
  }

  waitForIdle(): Promise<void> {
    if (this.active === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }
}

export function trackBrokerServices(
  services: WhatsAppMcpServices,
  activity: BrokerActivity,
): WhatsAppMcpServices {
  return {
    reader: tracked(services.reader, activity),
    media: tracked(services.media, activity),
    sends: tracked(services.sends, activity),
    reviews: tracked(services.reviews, activity),
  };
}

function tracked<T extends object>(target: T, activity: BrokerActivity): T {
  const methods = new Map<PropertyKey, (...input: unknown[]) => Promise<unknown>>();
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      let wrapped = methods.get(property);
      if (!wrapped) {
        wrapped = (...input: unknown[]) =>
          activity.run(() =>
            Promise.resolve(
              Reflect.apply(value as (...args: unknown[]) => unknown, object, input),
            ),
          );
        methods.set(property, wrapped);
      }
      return wrapped;
    },
  });
}
