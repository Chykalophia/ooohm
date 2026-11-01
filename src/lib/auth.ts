import "server-only";
import { eq } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { magicLink } from "better-auth/plugins";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { db, schema } from "@/db";
import { type Actor, toActor } from "@/domain/actor";
import { env, googleEnabled } from "@/lib/env";
import { log } from "@/lib/log";
import { sendMail } from "@/lib/mail";

/**
 * OOOhm is invite-only: people sign in with an account an admin created for them.
 * Neither magic links nor Google sign-in will create new users.
 */
export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  // Admins own people's names: a self-chosen name would reach approvers' inboxes and
  // emails, where it could impersonate a coworker or pose as instructions.
  disabledPaths: ["/update-user"],
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),
  user: {
    // Set by admins and the seed script, never by the person signing in.
    additionalFields: {
      companyId: { type: "string", required: false, input: false },
      departmentId: { type: "string", required: false, input: false },
      managerId: { type: "string", required: false, input: false },
      role: { type: "string", required: false, defaultValue: "employee", input: false },
      canSelfApprove: { type: "boolean", required: false, defaultValue: false, input: false },
      isActive: { type: "boolean", required: false, defaultValue: true, input: false },
    },
  },
  databaseHooks: {
    session: {
      create: {
        // Deactivated people get no new session from any sign-in method, including a
        // magic link sent before they were deactivated. Returning false aborts the create.
        before: async (session) => {
          const [owner] = await db
            .select({ isActive: schema.user.isActive })
            .from(schema.user)
            .where(eq(schema.user.id, session.userId));
          return owner?.isActive ? undefined : false;
        },
      },
    },
  },
  socialProviders: googleEnabled
    ? {
        google: {
          clientId: env.GOOGLE_CLIENT_ID!,
          clientSecret: env.GOOGLE_CLIENT_SECRET!,
          disableImplicitSignUp: true,
        },
      }
    : undefined,
  account: {
    // Lets an invited user who first used a magic link later sign in with Google (same email).
    accountLinking: { enabled: true, trustedProviders: ["google"] },
  },
  plugins: [
    magicLink({
      disableSignUp: true,
      expiresIn: 60 * 15,
      sendMagicLink: async ({ email, url }) => {
        // The API answers 200 for every address, so it can't be used to discover who
        // works here. The lookup and the send both run after the response is sent:
        // awaiting them would make real accounts answer measurably slower (timing leak),
        // and a send failure would turn into a 500 only for real users.
        after(async () => {
          try {
            const [existing] = await db
              .select({ isActive: schema.user.isActive })
              .from(schema.user)
              .where(eq(schema.user.email, email.toLowerCase()));
            // Only email people who have an active account, never strangers.
            if (!existing?.isActive) return;

            await sendMail({
              to: email,
              subject: "Your OOOhm sign-in link",
              text: `Sign in to OOOhm:\n\n${url}\n\nThis link expires in 15 minutes. If you didn't ask for it, you can ignore this email.`,
              html: `<p>Sign in to OOOhm:</p><p><a href="${url}">Sign in</a></p><p style="color:#6b7280">This link expires in 15 minutes. If you didn't ask for it, you can ignore this email.</p>`,
            });
          } catch (err) {
            log.error({ err }, "magic_link_send_failed");
          }
        });
      },
    }),
    nextCookies(), // must stay last
  ],
});

export type Session = typeof auth.$Infer.Session;

/** Data access layer entry point: the signed-in user, or a redirect to /sign-in. */
export async function requireUser() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session || session.user.isActive === false) redirect("/sign-in");
  return session.user;
}

/**
 * The signed-in user plus the `Actor` that services act for. `actor` is `null` while
 * the user is not attached to a company; such a user can sign in but not act.
 * Redirects to /sign-in when there is no active session.
 */
export async function requireActor(): Promise<{ user: Session["user"]; actor: Actor | null }> {
  const user = await requireUser();
  return { user, actor: toActor(user) };
}
