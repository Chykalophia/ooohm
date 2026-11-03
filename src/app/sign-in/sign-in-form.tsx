"use client";

import { useState } from "react";
import { ErrorMessage } from "@/components/forms/form-status";
import { TextField } from "@/components/ui/fields";
import { buttonClass, cx, textLink } from "@/components/ui/styles";
import { authClient } from "@/lib/auth-client";

const GENERIC_ERROR = "Something went wrong. Try again.";

type State = { kind: "idle" } | { kind: "sending" } | { kind: "sent"; email: string } | { kind: "error"; message: string };

export function SignInForm({ googleEnabled, linkFailed }: { googleEnabled: boolean; linkFailed: boolean }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<State>(
    linkFailed ? { kind: "error", message: "That sign-in link didn't work. Request a new one." } : { kind: "idle" },
  );

  async function sendLink(e: React.FormEvent) {
    e.preventDefault();
    if (state.kind === "sending") return;
    // Accounts are stored lowercase; normalize so "Ana@Co.com " works too.
    const normalized = email.trim().toLowerCase();
    setState({ kind: "sending" });
    try {
      const { error } = await authClient.signIn.magicLink({ email: normalized, callbackURL: "/", errorCallbackURL: "/sign-in" });
      if (error) {
        setState({ kind: "error", message: error.message ?? GENERIC_ERROR });
      } else {
        setState({ kind: "sent", email: normalized });
      }
    } catch {
      setState({ kind: "error", message: GENERIC_ERROR });
    }
  }

  async function signInWithGoogle() {
    try {
      const { error } = await authClient.signIn.social({ provider: "google", callbackURL: "/", errorCallbackURL: "/sign-in" });
      if (error) setState({ kind: "error", message: error.message ?? GENERIC_ERROR });
    } catch {
      setState({ kind: "error", message: GENERIC_ERROR });
    }
  }

  if (state.kind === "sent") {
    return (
      <div role="status" className="space-y-2 text-center">
        <p className="font-medium">Check your email</p>
        <p className="text-sm text-muted">
          We sent a sign-in link to <span className="text-foreground">{state.email}</span>. It expires in 15 minutes.
        </p>
        <button type="button" className={cx(textLink, "text-sm text-accent-ink")} onClick={() => setState({ kind: "idle" })}>
          Use a different email
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <form onSubmit={sendLink} className="space-y-3">
        <TextField
          label="Work email"
          type="email"
          required
          autoComplete="email"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
        />
        <button type="submit" aria-disabled={state.kind === "sending"} className={cx(buttonClass("primary"), "w-full")}>
          {state.kind === "sending" ? "Sending…" : "Email me a sign-in link"}
        </button>
      </form>

      {state.kind === "error" && (
        <ErrorMessage as="p" className="text-sm">
          {state.message}
        </ErrorMessage>
      )}

      {googleEnabled && (
        <>
          <div className="flex items-center gap-3 text-xs text-muted">
            <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
          </div>
          <button type="button" onClick={signInWithGoogle} className={cx(buttonClass("outline"), "w-full")}>
            Continue with Google
          </button>
        </>
      )}

      <p className="text-center text-xs text-muted">No account? Ask your admin to add you.</p>
    </div>
  );
}
