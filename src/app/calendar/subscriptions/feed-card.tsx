"use client";

import { useId } from "react";
import type { FeedKind } from "@/domain/calendar-feed";
import { ErrorMessage } from "@/components/forms/form-status";
import { KeepIt } from "@/components/forms/keep-it";
import { useConfirm } from "@/components/forms/use-confirm";
import { useFormAction } from "@/components/forms/use-form-action";
import { Card } from "@/components/ui/card";
import { CopyField } from "@/components/ui/copy-field";
import { buttonClass, confirmButton, dangerButton, subtleButton as subtle } from "@/components/ui/styles";
import { feedAction } from "./actions";
import { FEED_IDLE, type FeedState } from "./feed-state";

// The page holds two feeds; outlined buttons keep "Copy link" the one solid accent on screen.
const create = buttonClass("accent");

/** The feed's live link, as the server reports it. Dates are already formatted. */
export interface FeedStatus {
  since: string;
  lastUsed: string | null;
}

function NewLink({ url }: { url: string }) {
  return (
    <div className="space-y-2">
      <CopyField label="Your new link" value={url} copyLabel="Copy link" selectedText="The link is selected." />
      <p className="text-sm text-muted">
        Paste it into your calendar app now. It won&apos;t be shown again, because OOOhm doesn&apos;t keep a copy. Anyone with the
        link can see this calendar, so keep it to yourself.
      </p>
    </div>
  );
}

/**
 * One feed on the subscriptions page: create its link, or replace or turn off the
 * live one. Replacing and turning off take a second click, because either breaks
 * calendars already subscribed to the old link.
 */
export function FeedCard({
  kind,
  title,
  description,
  status,
}: {
  kind: FeedKind;
  title: string;
  description: string;
  status: FeedStatus | null;
}) {
  const { asking: confirming, ask, back, done, questionRef, openerRef } = useConfirm<"issue" | "revoke">();
  const { state, dispatch, pending, onSubmit } = useFormAction<FeedState>(async (prev, formData) => {
    const next = await feedAction(prev, formData);
    if (next.status !== "error") done();
    return next;
  }, FEED_IDLE);
  const headingId = useId();
  const live = status !== null;

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
    <Card aria-labelledby={headingId} className="space-y-5">
      <div className="space-y-1">
        <h2 id={headingId} className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        <p className="text-sm text-muted">{description}</p>
      </div>

      {state.status === "issued" && live ? (
        <NewLink url={state.url} />
      ) : (
        live && (
          <p className="text-sm">
            On since {status.since}.{" "}
            <span className="text-muted">
              {status.lastUsed ? `Last fetched by a calendar app on ${status.lastUsed}.` : "Not fetched by a calendar app yet."}
            </span>
          </p>
        )
      )}

      {!live && form("issue", pending ? "Creating…" : "Create link", create)}

      {live && confirming === null && (
        <div className="flex flex-wrap gap-5">
          <button ref={openerRef("issue")} type="button" onClick={() => ask("issue")} className={subtle}>
            Get a new link
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
    </Card>
  );
}
