import { ImageResponse } from "next/og";
import { connection } from "next/server";
import { OHM_OFFSET, OHM_PATH, OHM_SCALE, OHM_STROKE_WIDTH, appearanceAccent, markColors } from "@/lib/brand-mark";
import { serviceContext } from "@/server/runtime";
import { getAppearance } from "@/server/services/appearance";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/**
 * The home-screen icon, in the company's accent. A full square: the phone rounds the
 * corners itself.
 */
export default async function AppleIcon() {
  await connection();
  const { tile, mark } = markColors(appearanceAccent(await getAppearance(serviceContext())));
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: tile }}>
        <svg width="180" height="180" viewBox="0 0 32 32">
          <g transform={`translate(${OHM_OFFSET} ${OHM_OFFSET}) scale(${OHM_SCALE})`}>
            <path d={OHM_PATH} fill="none" stroke={mark} strokeWidth={OHM_STROKE_WIDTH} strokeLinejoin="round" />
          </g>
        </svg>
      </div>
    ),
    size,
  );
}
