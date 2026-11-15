import "server-only";
import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

/** Better Auth's GET and POST handlers for `/api/auth/*`, which the route re-exports. */
export const authRouteHandlers = toNextJsHandler(auth);
