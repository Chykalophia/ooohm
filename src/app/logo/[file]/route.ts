import { serviceContext } from "@/server/runtime";
import { handleLogoFetch } from "./logo-fetch";

/**
 * The company's logo: `GET /logo/<sha256>.<png|jpg>`. Public, like the favicon: the
 * sign-in page shows it before anyone signs in, and emails point at it. See
 * {@link handleLogoFetch} for the responses.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }): Promise<Response> {
  return handleLogoFetch({ ctx: serviceContext(), file: (await params).file });
}
