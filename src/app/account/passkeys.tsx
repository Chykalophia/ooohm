"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { authClient } from "@/lib/auth-client";
import { ErrorMessage } from "@/components/forms/form-status";
import { TextField } from "@/components/ui/fields";
import { Item, ItemList } from "@/components/ui/card";
import { buttonClass, confirmButton, dangerButton, subtleButton } from "@/components/ui/styles";

/** A passkey as the account page shows it; `added` is already formatted in the company's zone. */
export type PasskeyRow = { id: string; name: string | null; added: string | null; synced: boolean };

const NAME_MAX_LENGTH = 60;

/** What the browser reports when the person closes its passkey prompt. */
const CANCELLED = new Set(["AUTH_CANCELLED", "ERROR_CEREMONY_ABORTED"]);

/**
 * The person's passkeys: add one for this device or password manager, and remove ones
 * they no longer use. Adding and removing run in the browser through Better Auth's
 * passkey plugin (the browser makes and holds the key); the list is the server's, so it
 * refreshes after each change.
 */
export function Passkeys({ passkeys }: { passkeys: readonly PasskeyRow[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, startBusy] = useTransition();

  function add(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setNotice(null);
    startBusy(async () => {
      const { error: failed } = await authClient.passkey.addPasskey({ name: name.trim() || undefined });
      if (failed) {
        // Closing the browser's prompt is a choice, not an error to alarm anyone with.
        if ("code" in failed && CANCELLED.has(failed.code)) setNotice("No passkey was added.");
        else setError("That passkey couldn't be added. Try again.");
        return;
      }
      setName("");
      setNotice("Passkey added. Next time, choose “Sign in with a passkey”.");
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Sign in with your fingerprint, face or device PIN instead of waiting for an email. Add one on each device you use; a password
        manager can keep one for all of them.
      </p>

      {passkeys.length > 0 && (
        <ItemList>
          {passkeys.map((p) => (
            <PasskeyItem key={p.id} passkey={p} onError={setError} />
          ))}
        </ItemList>
      )}

      <form onSubmit={add} className="flex flex-wrap items-end gap-3">
        <TextField
          label="Name"
          optional
          name="passkeyName"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={NAME_MAX_LENGTH}
          placeholder="Work laptop"
          className="min-w-48 flex-1"
        />
        <button type="submit" aria-disabled={busy} className={buttonClass("outline", "sm")}>
          {busy ? "Waiting for your device…" : passkeys.length === 0 ? "Add a passkey" : "Add another passkey"}
        </button>
      </form>
      <p aria-live="polite" className="text-sm">
        {error && <ErrorMessage className="text-sm">{error}</ErrorMessage>}
        {!error && notice && <span className="text-accent-ink">{notice}</span>}
      </p>
    </div>
  );
}

/** One passkey with a two-step Remove (removing the only one leaves email sign-in, which always works). */
function PasskeyItem({ passkey: p, onError }: { passkey: PasskeyRow; onError: (message: string | null) => void }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, startBusy] = useTransition();
  const label = p.name || "Passkey";

  function remove() {
    startBusy(async () => {
      const { error } = await authClient.passkey.deletePasskey({ id: p.id });
      if (error) {
        onError("That passkey couldn't be removed. Try again.");
        return;
      }
      onError(null);
      router.refresh();
    });
  }

  return (
    <Item className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="font-medium break-words">{label}</p>
        <p className="text-sm text-muted">
          {[p.added && `Added ${p.added}`, p.synced && "Synced across your devices"].filter(Boolean).join(" · ")}
        </p>
      </div>
      {confirming ? (
        <span className="flex items-center gap-3 text-sm">
          <span>Remove it?</span>
          <button type="button" onClick={remove} aria-disabled={busy} className={confirmButton}>
            {busy ? "Removing…" : "Remove"}
          </button>
          <button type="button" onClick={() => setConfirming(false)} className={subtleButton}>
            Keep it
          </button>
        </span>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} className={dangerButton} aria-label={`Remove ${label}`}>
          Remove
        </button>
      )}
    </Item>
  );
}
