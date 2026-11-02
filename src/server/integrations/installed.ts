import type { Adapter } from "./adapter";

/**
 * The adapters this deployment registers. OOOhm v1 ships none.
 *
 * To add one later (say Gusto): write `src/server/integrations/adapters/gusto.ts`
 * exporting an object that implements `Adapter`, and list it here. Nothing else in the
 * app changes: the worker delivers events to it, and the Connectors screen
 * (Admin → Integrations → Connectors) shows its health and, if it syncs people or
 * allowances, a "Sync now" action.
 */
export const installedAdapters: readonly Adapter[] = [];
