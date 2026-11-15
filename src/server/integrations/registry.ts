import "server-only";
import { type AdapterRegistry, createAdapterRegistry } from "./adapter";
import { installedAdapters } from "./installed";

/**
 * The registry the app and the worker use: whatever `installed.ts` lists. Empty in v1.
 * It lives apart from `adapter.ts` (the port) so the port never imports the adapters
 * that implement it.
 */
export const adapterRegistry: AdapterRegistry = createAdapterRegistry(installedAdapters);
