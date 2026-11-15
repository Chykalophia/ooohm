/**
 * Component test setup, preloaded by `pnpm test:components` (`--import`). It runs in
 * every test file's process before the file itself:
 *
 * - a jsdom window and document as globals (`global-jsdom`), so React DOM renders;
 * - stand-ins for what only the Next.js runtime provides: `next/navigation` (no app
 *   router is mounted here) and `server-only`;
 * - Testing Library's cleanup after each test.
 *
 * Client components import their server actions directly (`./actions`). Those modules
 * pull in the database and the session, so a test replaces them with {@link stubModule}
 * before it imports the component (with a dynamic `import()`).
 *
 * The suite runs without the `react-server` condition: client components get the
 * browser builds of React, as they do in the app.
 */
import { afterEach, mock } from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";
import globalJsdom from "global-jsdom";

globalJsdom("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });

// Node has its own versions of these, which global-jsdom leaves in place; the DOM only
// accepts jsdom's (`new FormData(form)`, `el.dispatchEvent(new CustomEvent(...))`).
for (const name of ["FormData", "Event", "CustomEvent", "EventTarget"] as const) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: window[name] });
}

// React's act() environment, so state updates in tests flush without warnings.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Components call both `setTimeout` (Node's) and `window.setTimeout` (jsdom's). The window
// ones look up the global at call time, so `mock.timers` drives both.
for (const name of ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] as const) {
  Object.defineProperty(window, name, {
    configurable: true,
    writable: true,
    value: (...args: unknown[]) => (globalThis[name] as (...a: unknown[]) => unknown)(...args),
  });
}

// jsdom lacks these; components read them.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}

/** The router calls components made, so a test can check that a page refreshed. */
export const router = { refreshes: 0, pushes: [] as string[] };

const appRouter = {
  refresh: () => void router.refreshes++,
  push: (href: string) => void router.pushes.push(href),
  replace: (href: string) => void router.pushes.push(href),
  back() {},
  forward() {},
  prefetch() {},
};

mock.module("next/navigation", {
  namedExports: {
    // One instance, as in the app: effects that depend on the router don't rerun.
    useRouter: () => appRouter,
    usePathname: () => "/",
    useSearchParams: () => new URLSearchParams(),
    redirect: (href: string) => {
      throw new Error(`redirect(${href}) called in a component test`);
    },
  },
});
mock.module("server-only", { namedExports: {} });

const root = path.resolve(import.meta.dirname, "../..");

/**
 * Replaces a module under `src/` (named as its `@/` import, without the extension) by
 * `exports` before anything imports it. Returns those exports, so a test can swap one
 * implementation per test (`actions.decideLeaveAction = ...`); the stand-in module calls
 * whatever is there at call time.
 */
export function stubModule<T extends Record<string, (...args: never[]) => unknown>>(alias: string, exports: T): T {
  const file = path.join(root, "src", alias.replace(/^@\//, "")) + ".ts";
  const live = { ...exports };
  const namedExports = Object.fromEntries(
    Object.keys(exports).map((name) => [name, (...args: never[]) => (live[name as keyof T] as (...a: never[]) => unknown)(...args)]),
  );
  mock.module(pathToFileURL(file).href, { namedExports });
  return live;
}

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  router.refreshes = 0;
  router.pushes = [];
});
