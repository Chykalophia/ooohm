import "server-only";
import { eq } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { magicLink } from "better-auth/plugins";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db, schema } from "@/db";
import { env, googleEnabled } from "@/lib/env";
import { sendMail } from "@/lib/mail";

/**
 * OOOhm is invite-only: people sign in with an account an admin created for them.
 * Neither magic links nor Google sign-in will create new users.
 */
export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
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
        // Only email people who have an active account. The API still answers 200
        // for unknown addresses so it can't be used to discover who works here,
        // and so it can't be used to send mail to strangers.
        const [existing] = await db
          .select({ isActive: schema.user.isActive })
          .from(schema.user)
          .where(eq(schema.user.email, email.toLowerCase()));
        if (!existing?.isActive) return;

        await sendMail({
          to: email,
          subject: "Your OOOhm sign-in link",
          text: `Sign in to OOOhm:\n\n${url}\n\nThis link expires in 15 minutes. If you didn't ask for it, you can ignore this email.`,
          html: `<p>Sign in to OOOhm:</p><p><a href="${url}">Sign in</a></p><p style="color:#6b7280">This link expires in 15 minutes. If you didn't ask for it, you can ignore this email.</p>`,
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
