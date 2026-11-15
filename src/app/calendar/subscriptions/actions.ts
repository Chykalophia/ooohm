"use server";

import { z } from "zod";
import { addToCalendarLinks, FEED_KINDS, FEED_SHORT_NAMES } from "@/shared/kernel/calendar-feed";
import { issueCalendarFeed, revokeCalendarFeed } from "@/modules/calendar";
import { map, type ServiceResult } from "@/shared/lib/result";
import { runStateAction } from "@/app/_lib/server-action";
import type { FeedState } from "./feed-state";

const feedSchema = z.object({
  kind: z.enum(FEED_KINDS),
  intent: z.enum(["issue", "revoke"]),
});

/** `forbidden` here means the account was deactivated, not a request it can't touch. */
const FEED_MESSAGES = { forbidden: "Your account can't manage calendar links right now. Ask an admin." };

/**
 * Calendar subscriptions: creates or replaces a feed link (`issue`), or turns a feed
 * off (`revoke`), for the signed-in person. Never logs the link.
 */
export async function feedAction(_prev: FeedState, formData: FormData): Promise<FeedState> {
  const intent = formData.get("intent") === "revoke" ? "revoke" : "issue";
  return runStateAction(
    `calendar_feed_${intent}`,
    formData,
    feedSchema,
    async (ctx, actor, { kind, intent }): Promise<ServiceResult<FeedState>> => {
      if (intent === "issue") {
        return map(await issueCalendarFeed(ctx, actor, kind), ({ url }): FeedState => ({ status: "issued", url, links: addToCalendarLinks(url, FEED_SHORT_NAMES[kind]) }));
      }
      return map(await revokeCalendarFeed(ctx, actor, kind), (): FeedState => ({ status: "off" }));
    },
    { messages: FEED_MESSAGES },
  );
}
