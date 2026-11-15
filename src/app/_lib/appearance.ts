import "server-only";
import { cache } from "react";
import { serviceContext } from "@/server/runtime";
import { getAppearance } from "@/modules/organisation";

/** The company's look, read once per request: the root layout and Home share the one read. */
export const requestAppearance = cache(() => getAppearance(serviceContext()));
