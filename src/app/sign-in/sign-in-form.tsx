"use client";

import { useState } from "react";
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
        <button type="button" className="text-sm text-accent-ink underline-offset-4 hover:underline" onClick={() => setState({ kind: "idle" })}>
          Use a different email
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <form onSubmit={sendLink} className="space-y-3">
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Work email</span>
          <input
            type="email"
            required
            autoComplete="email"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            placeholder="you@company.com"
          />
        </label>
        <button
          type="submit"
          disabled={state.kind === "sending"}
          className="w-full rounded-lg bg-accent px-3 py-2 font-medium text-accent-foreground disabled:opacity-60"
        >
          {state.kind === "sending" ? "Sending…" : "Email me a sign-in link"}
        </button>
      </form>

      {state.kind === "error" && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {state.message}
        </p>
      )}

      {googleEnabled && (
        <>
          <div className="flex items-center gap-3 text-xs text-muted">
            <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
          </div>
          <button
            type="button"
            onClick={signInWithGoogle}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 font-medium hover:bg-background"
          >
            Continue with Google
          </button>
        </>
      )}

      <p className="text-center text-xs text-muted">No account? Ask your admin to add you.</p>
    </div>
  );
}
