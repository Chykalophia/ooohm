import { normalizeHexColor } from "@/lib/color";
import { cx } from "./styles";

/** A small dot in a leave type's colour. Decorative: the text beside it carries the meaning. */
export function ColorDot({ color }: { color: string }) {
  return <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: normalizeHexColor(color) }} aria-hidden />;
}

/** Text led by a {@link ColorDot}: a leave type's name, or the dates of leave of that type. */
export function ColorLabel({
  color,
  as: Tag = "p",
  className,
  children,
}: {
  color: string;
  as?: "p" | "span" | "h3";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Tag className={cx("flex items-center gap-2", className)}>
      <ColorDot color={color} />
      {children}
    </Tag>
  );
}
