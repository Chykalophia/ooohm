import { card, cx, surface } from "./styles";

type CardTag = "section" | "div" | "li" | "article";

const PADDING = {
  /** Small cards in a grid. */
  sm: `${surface} p-4`,
  md: card,
  /** A card that is the whole page, such as sign-in. */
  lg: `${surface} p-8`,
} as const;

/** A bordered surface for one self-contained thing: a form, a setting, a person. */
export function Card({
  as: Tag = "section",
  padding = "md",
  className,
  ...props
}: React.HTMLAttributes<HTMLElement> & { as?: CardTag; padding?: keyof typeof PADDING }) {
  return <Tag className={cx(PADDING[padding], className)} {...props} />;
}

/**
 * A list of records on one surface, divided by hairlines: people, holidays, requests.
 * Use `ordered` when the order means something (newest first, the form's default first).
 */
export function ItemList({ ordered = false, className, ...props }: React.HTMLAttributes<HTMLElement> & { ordered?: boolean }) {
  const Tag = ordered ? "ol" : "ul";
  return <Tag className={cx("divide-y divide-border", surface, className)} {...props} />;
}

/** One row of an {@link ItemList}. */
export function Item({ className, ...props }: React.LiHTMLAttributes<HTMLLIElement>) {
  return <li className={cx("p-4", className)} {...props} />;
}
