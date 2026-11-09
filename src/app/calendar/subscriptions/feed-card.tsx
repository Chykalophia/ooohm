"use client";

import { useId } from "react";
import type { AddToCalendarLinks, FeedKind } from "@/domain/calendar-feed";
import { ErrorMessage } from "@/components/forms/form-status";
import { KeepIt } from "@/components/forms/keep-it";
import { useConfirm } from "@/components/forms/use-confirm";
import { useFormAction } from "@/components/forms/use-form-action";
import { Card } from "@/components/ui/card";
import { CopyField } from "@/components/ui/copy-field";
import { buttonClass, confirmButton, cx, dangerButton, subtleButton as subtle } from "@/components/ui/styles";
import { feedAction } from "./actions";
import { FEED_IDLE, type FeedState } from "./feed-state";

// Outlined buttons keep "Copy link" the one solid accent on screen.
const create = buttonClass("accent");
const addTo = buttonClass("outline", "sm");

/** The feed's live link, as the server reports it. Dates are already formatted. */
export interface FeedStatus {
  since: string;
  lastUsed: string | null;
  /** The link's last 4 characters; null for links made before OOOhm kept them. */
  hint: string | null;
}

/**
 * The new link, shown this once: straight into a calendar app with one tap, or copied
 * by hand. Opening one of the add links hands the secret link to that calendar
 * service, which is what subscribing does anyway.
 */
function NewLink({ url, links }: { url: string; links: AddToCalendarLinks }) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-sm font-medium">Add it to your calendar</p>
        <div className="flex flex-wrap gap-2">
          <a href={links.google} target="_blank" rel="noopener noreferrer" className={addTo}>
            Google Calendar<span className="sr-only"> (opens in a new tab)</span>
          </a>
          <a href={links.apple} className={addTo}>
            Apple Calendar
          </a>
          <a href={links.outlook} target="_blank" rel="noopener noreferrer" className={addTo}>
            Outlook<span className="sr-only"> (opens in a new tab)</span>
          </a>
        </div>
        <p className="text-sm text-muted">Google Calendar adds a subscription on a computer only, not in its phone app.</p>
      </div>
      <div className="space-y-2">
        <CopyField label="Or copy the link" value={url} copyLabel="Copy link" selectedText="The link is selected." />
        <p className="text-sm text-muted">
          It won&apos;t be shown again, because OOOhm doesn&apos;t keep a copy. Anyone with the link can see this calendar, so keep it
          to yourself.
        </p>
      </div>
    </div>
  );
}

/** What a live link's card says: that it still works, which link it is, and when a calendar last fetched it. */
function LiveStatus({ status }: { status: FeedStatus }) {
  return (
    <div className="space-y-1 text-sm">
      <p>
        Your link{status.hint && <> ending in <span className="font-mono">{status.hint}</span></>} is on and working. Calendars using
        it keep updating.
      </p>
      <p className="text-muted">
        On since {status.since}. {status.lastUsed ? `Last fetched by a calendar app on ${status.lastUsed}.` : "Not fetched by a calendar app yet."}
      </p>
    </div>
  );
}

/**
 * One feed on the subscriptions page: create its link, or replace or turn off the
 * live one. Replacing and turning off take a second click, because either breaks
 * calendars already subscribed to the old link. Replacing is offered as the way back
 * from a lost link, since a link is never shown twice.
 *
 * @param quiet The page's second feed: a plain section under the main card, with a
 *   smaller heading and an outlined button, so the main feed stays the obvious choice.
 */
export function FeedCard({
  kind,
  title,
  description,
  status,
  quiet = false,
}: {
  kind: FeedKind;
  title: string;
  description: string;
  status: FeedStatus | null;
  quiet?: boolean;
}) {
  const { asking: confirming, ask, back, done, questionRef, openerRef } = useConfirm<"issue" | "revoke">();
  const { state, dispatch, pending, onSubmit } = useFormAction<FeedState>(async (prev, formData) => {
    const next = await feedAction(prev, formData);
    if (next.status !== "error") done();
    return next;
  }, FEED_IDLE);
  const headingId = useId();
  const live = status !== null;
  const Body = quiet ? "section" : Card;

  const form = (intent: "issue" | "revoke", label: string, className: string) => (
    <form action={dispatch} onSubmit={onSubmit}>
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="intent" value={intent} />
      <button type="submit" aria-disabled={pending} className={className}>
        {label}
      </button>
    </form>
  );

  return (
    <Body aria-labelledby={headingId} className={cx("space-y-5", quiet && "px-1")}>
      <div className="space-y-1">
        <h2 id={headingId} className={quiet ? "text-base font-semibold" : "text-lg font-semibold tracking-tight"}>
          {title}
        </h2>
        <p className="text-sm text-muted">{description}</p>
      </div>

      {state.status === "issued" && live ? <NewLink url={state.url} links={state.links} /> : live && <LiveStatus status={status} />}

      {!live && form("issue", pending ? "Creating…" : "Create link", quiet ? addTo : create)}

      {live && confirming === null && (
        <div className="flex flex-wrap gap-5">
          <button ref={openerRef("issue")} type="button" onClick={() => ask("issue")} className={subtle}>
            Lost it? Replace the link
          </button>
          <button ref={openerRef("revoke")} type="button" onClick={() => ask("revoke")} className={subtle}>
            Turn off
          </button>
        </div>
      )}
      {live && confirming !== null && (
        <div className="space-y-3">
          <p ref={questionRef} tabIndex={-1} className="text-sm outline-none">
            {confirming === "issue"
              ? "Your current link will stop working, and calendars using it will stop updating."
              : "Calendars using this link will stop updating."}
          </p>
          <div className="flex flex-wrap items-center gap-5">
            {confirming === "issue"
              ? form("issue", pending ? "Creating…" : "Yes, get a new link", confirmButton)
              : form("revoke", pending ? "Turning off…" : "Yes, turn it off", dangerButton)}
            <KeepIt pending={pending} onBack={back} className={subtle} />
          </div>
        </div>
      )}

      {state.status === "error" && (
        <ErrorMessage as="p" className="text-sm">
          {state.message}
        </ErrorMessage>
      )}
    </Body>
  );
}
