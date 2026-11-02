"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { FEED_KINDS } from "@/domain/calendar-feed";
import { requireActor } from "@/lib/auth";
import { serviceContext } from "@/server/runtime";
import { issueCalendarFeed, revokeCalendarFeed } from "@/server/services/calendar-feeds";
import { messageFor, runActionWith } from "@/app/run-action";
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
  const { actor } = await requireActor();
  if (!actor) return { status: "error", message: messageFor("no_company") };

  const parsed = feedSchema.safeParse({ kind: formData.get("kind"), intent: formData.get("intent") });
  if (!parsed.success) return { status: "error", message: messageFor("invalid_input") };
  const { kind, intent } = parsed.data;

  return runActionWith(
    `calendar_feed_${intent}`,
    async (): Promise<FeedState> => {
      const ctx = serviceContext();
      let state: FeedState;
      if (intent === "issue") {
        const { url } = await issueCalendarFeed(ctx, actor, kind);
        state = { status: "issued", url };
      } else {
        await revokeCalendarFeed(ctx, actor, kind);
        state = { status: "off" };
      }
      refresh();
      return state;
    },
    FEED_MESSAGES,
  );
}
