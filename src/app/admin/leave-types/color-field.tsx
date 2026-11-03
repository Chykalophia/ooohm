"use client";

import { useId, useState } from "react";
import { normalizeHexColor, readableTextColor } from "@/lib/color";
import { cx, focusRing } from "@/components/ui/styles";

/**
 * The leave type colour, with a live preview of how its calendar chip will look: sample
 * text in black or white, whichever reads better on the colour. The preview is
 * decorative (hidden from screen readers); the hex value beside it is the text.
 */
export function ColorField({ defaultColor }: { defaultColor: string }) {
  const id = useId();
  const [color, setColor] = useState(normalizeHexColor(defaultColor));
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        Colour
      </label>
      <div className="flex items-center gap-3">
        <input
          id={id}
          type="color"
          name="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          className={cx("h-10 w-14 cursor-pointer rounded-lg border border-border bg-surface p-1", focusRing)}
        />
        <span
          className="rounded-md px-2 py-1 text-sm font-medium"
          style={{ backgroundColor: color, color: readableTextColor(color) }}
          aria-hidden
        >
          Aa
        </span>
        <span className="font-mono text-sm text-muted">{color}</span>
      </div>
    </div>
  );
}
