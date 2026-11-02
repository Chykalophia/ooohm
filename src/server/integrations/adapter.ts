/**
 * The adapter seam: how a third-party integration (a payroll or HR system, a chat app)
 * plugs into OOOhm without changing core code. v1 ships none; `installed.ts` lists what
 * a deployment registers, and is empty.
 *
 * An adapter sees the same versioned envelopes webhooks do (outbound), and may hand
 * people and allowances back (inbound). It never touches the database: the outbox
 * worker delivers events to it with the webhook retry schedule, and
 * `applyInboundSync` writes what it returns, with audit rows and events, under the
 * same locks an admin's edits take.
 */
import type { EventEnvelope } from "@/domain/integrations";
import { installedAdapters } from "./installed";

/** What an adapter is given for one call. Configuration and credentials for a company will be added here. */
export interface AdapterContext {
  /** The company the call is for. */
  companyId: string;
  now: () => Date;
  /** Aborted when the worker is shutting down or the call has run too long. */
  signal: AbortSignal;
}

/** A person as an external system knows them. Matched to OOOhm people by email. */
export interface InboundUser {
  email: string;
  name: string;
}

/**
 * A yearly allowance as an external system knows it: the person (by email), the leave
 * type (by code), the year, the allowance `days` and, optionally, an adjustment.
 */
export interface InboundBalance {
  email: string;
  leaveTypeCode: string;
  year: number;
  days: number;
  /** Omitted: an existing row keeps its adjustment, a new row gets 0. */
  adjustmentDays?: number;
}

export interface AdapterHealth {
  ok: boolean;
  /** One calm line for the admin screen, e.g. "Connected to Acme Payroll" or "The token was rejected". */
  detail?: string;
}

export interface Adapter {
  /** Stable and unique, e.g. `gusto`; stored with every delivery to it. Never rename one. */
  readonly id: string;
  /** What admins see, e.g. "Gusto". */
  readonly displayName: string;
  /**
   * Whether to deliver `companyId`'s events of `eventType` (e.g. `leave.approved`) to
   * {@link Adapter.deliver}. Adapters are registered per deployment, so this is also where
   * an adapter that a company must connect first says no for the companies that have not;
   * dispatch needs no change for that. Called inside the dispatch transaction: keep it
   * synchronous and cheap. Throwing counts as `false` (logged), never stalls dispatch.
   */
  handles(eventType: string, companyId: string): boolean;
  /**
   * Outbound sync of one event. Resolve when the other system has it; throw to have the
   * worker retry on the webhook schedule (1 minute up to 24 hours, 8 attempts). Must be
   * idempotent on `event.id`: delivery is at least once.
   */
  deliver(event: EventEnvelope, ctx: AdapterContext): Promise<void>;
  /** Inbound sync of people, applied by `applyInboundSync`. */
  syncUsers?(ctx: AdapterContext): Promise<InboundUser[]>;
  /** Inbound sync of allowances, applied by `applyInboundSync`. */
  syncBalances?(ctx: AdapterContext): Promise<InboundBalance[]>;
  /** Whether the adapter can reach its system now; shown on the Connectors screen (Admin → Integrations → Connectors). */
  healthCheck(ctx: AdapterContext): Promise<AdapterHealth>;
}

/** The adapters a process knows about, by id. */
export interface AdapterRegistry {
  /** @throws Error when an adapter with the same id is already registered. */
  register(adapter: Adapter): void;
  /** Every registered adapter, in registration order. */
  list(): readonly Adapter[];
  get(id: string): Adapter | undefined;
}

const ADAPTER_ID = /^[a-z][a-z0-9_-]{1,39}$/;

export function createAdapterRegistry(initial: readonly Adapter[] = []): AdapterRegistry {
  const adapters = new Map<string, Adapter>();
  const registry: AdapterRegistry = {
    register(adapter) {
      if (!ADAPTER_ID.test(adapter.id)) throw new Error(`Adapter id "${adapter.id}" must match ${ADAPTER_ID}.`);
      if (adapters.has(adapter.id)) throw new Error(`An adapter with id "${adapter.id}" is already registered.`);
      adapters.set(adapter.id, adapter);
    },
    list: () => [...adapters.values()],
    get: (id) => adapters.get(id),
  };
  for (const adapter of initial) registry.register(adapter);
  return registry;
}

/** The registry the app and the worker use: whatever `installed.ts` lists. Empty in v1. */
export const adapterRegistry: AdapterRegistry = createAdapterRegistry(installedAdapters);
