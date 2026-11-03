import { connection } from "next/server";
import { appearanceAccent, appearanceDarkMark, faviconSvg } from "@/lib/brand-mark";
import { serviceContext } from "@/server/runtime";
import { getAppearance } from "@/server/services/appearance";

/**
 * The tab icon, in the company's accent, so a theme change in Admin → Appearance shows
 * in the tab too. Public: browsers fetch it before anyone signs in. Cached briefly, so a
 * new theme reaches open tabs within minutes.
 */
export async function GET() {
  await connection();
  const appearance = await getAppearance(serviceContext());
  return new Response(faviconSvg(appearanceAccent(appearance), appearanceDarkMark(appearance)), {
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=300" },
  });
}
