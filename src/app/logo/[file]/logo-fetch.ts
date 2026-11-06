import type { ServiceContext } from "@/server/context";
import { getLogoFile } from "@/server/services/appearance";

const notFound = () =>
  new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

/**
 * Answers `GET /logo/<sha256>.<png|jpg>` with its dependencies injected, so it can be
 * tested without Next. The name is the file's own hash, so a hit never changes and is
 * cached for a year; anything else is a bare 404. The file is only ever drawn as an
 * image: `nosniff` and an empty CSP keep a browser from treating it as anything else.
 */
export async function handleLogoFetch({ ctx, file }: { ctx: ServiceContext; file: string }): Promise<Response> {
  const found = await getLogoFile(ctx, file);
  if (!found) return notFound();
  return new Response(new Uint8Array(found.bytes), {
    headers: {
      "Content-Type": found.contentType,
      "Content-Length": String(found.bytes.byteLength),
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
    },
  });
}
