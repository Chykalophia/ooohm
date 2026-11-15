import {
  CORNER_LABELS,
  CORNER_STYLES,
  LAYOUTS,
  LAYOUT_LABELS,
  REQUEST_STYLES,
  REQUEST_STYLE_LABELS,
  THEMES,
  THEME_KEYS,
  type ThemeKey,
  type readAppearance,
} from "@/domain/appearance";
import { ActionForm } from "@/components/forms/action-form";
import { CheckboxField, SelectField } from "@/components/ui/fields";
import { card, choiceCard, cx, focusRing } from "@/components/ui/styles";
import { updateAppearanceAction } from "./actions";

type Appearance = ReturnType<typeof readAppearance>;

/** Leave colours for the previews, as a typical company sets them up. */
const SAMPLE_LEAVE = [
  ["Vacation", "#4f7cc9"],
  ["Sick", "#cc8429"],
  ["Personal", "#8a69c1"],
] as const;

/**
 * A small, real rendering of a theme: the same tokens the app uses, scoped to this box
 * by `data-ui`, so each option shows its own colours, type and corners.
 */
function ThemePreview({ theme }: { theme: ThemeKey }) {
  return (
    <span data-ui={theme} aria-hidden className="block rounded-xl p-3">
      <span className="block space-y-2 rounded-2xl border border-border bg-surface p-3">
        <span className="block text-sm font-semibold" style={{ fontFamily: "var(--display-font)" }}>
          Request time off
        </span>
        <span className="flex flex-wrap gap-1.5">
          {SAMPLE_LEAVE.map(([name, color]) => (
            <span key={name} className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px]">
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
              {name}
            </span>
          ))}
        </span>
        <span className="block text-[11px] text-muted">3 working days · 8.5 left after</span>
        <span className="flex items-center gap-2">
          <span className="rounded-(--button-radius) bg-accent px-3 py-1 text-xs font-medium text-accent-foreground shadow-(--button-shadow)">
            Send to Jonas
          </span>
          <span className="text-xs font-medium text-accent-ink">Cancel</span>
        </span>
      </span>
    </span>
  );
}

function ThemeChoice({ current }: { current: Appearance }) {
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">Theme</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {THEME_KEYS.map((key) => (
          <label
            key={key}
            className="cursor-pointer space-y-2 rounded-2xl border border-border p-2 has-[:checked]:border-accent has-[:checked]:ring-2 has-[:checked]:ring-accent/30 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/40"
          >
            <ThemePreview theme={key} />
            <span className="flex items-start gap-2 px-1 pb-1">
              <input type="radio" name="theme" value={key} defaultChecked={current.theme === key} className="mt-1 accent-[var(--accent)]" />
              <span>
                <span className="block text-sm font-medium">{THEMES[key].label}</span>
                <span className="block text-xs text-muted">{THEMES[key].description}</span>
              </span>
            </span>
          </label>
        ))}
      </div>
      <p className="text-xs text-muted">
        Only Classic, with its own accent, has a dark version: there each person’s choice of light, dark or automatic (on their account
        page) applies. The other themes are light only.
      </p>
    </fieldset>
  );
}

function AccentChoice({ current }: { current: Appearance }) {
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">Accent color</legend>
      <CheckboxField
        label="Use our own accent color instead of the theme’s"
        name="customAccent"
        defaultChecked={current.accentColor !== null}
        hint="It colors the main button, today’s date and selected items. Pale colors keep their fill and get a darker shade for text, so everything stays readable. The color below applies only while this is ticked."
      />
      <div className="flex items-center gap-3">
        <label htmlFor="accent-color" className="text-sm">
          Color
        </label>
        <input
          id="accent-color"
          type="color"
          name="accentColor"
          defaultValue={current.accentColor ?? THEMES[current.theme].accent}
          className={cx("h-9 w-14 cursor-pointer rounded-md border border-field bg-surface p-1", focusRing)}
        />
      </div>
    </fieldset>
  );
}

/** One setting as a row of radio cards, each with its label and description. */
function ChoiceCards<K extends string>({
  legend,
  name,
  keys,
  labels,
  current,
  note,
}: {
  legend: string;
  name: string;
  keys: readonly K[];
  labels: Record<K, { label: string; description: string }>;
  current: K;
  note: string;
}) {
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {keys.map((key) => (
          <label key={key} className={choiceCard}>
            <input type="radio" name={name} value={key} defaultChecked={current === key} className="mt-1 accent-[var(--accent)]" />
            <span>
              <span className="block text-sm font-medium">{labels[key].label}</span>
              <span className="block text-xs text-muted">{labels[key].description}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="text-xs text-muted">{note}</p>
    </fieldset>
  );
}

/** The company's theme, accent, corners, request style and layout, saved together. */
export function AppearanceForm({ current }: { current: Appearance }) {
  return (
    <section aria-label="Appearance settings" className={card}>
      <ActionForm action={updateAppearanceAction} submitLabel="Save appearance" pendingLabel="Saving…" className="space-y-6">
        <ThemeChoice current={current} />
        <AccentChoice current={current} />
        <SelectField
          label="Corners"
          name="corners"
          defaultValue={current.corners}
          options={CORNER_STYLES.map((c) => ({ value: c, label: CORNER_LABELS[c] }))}
          hint="Overrides how rounded cards, fields and buttons are in every theme."
        />
        <ChoiceCards
          legend="How people ask for time off"
          name="requestStyle"
          keys={REQUEST_STYLES}
          labels={REQUEST_STYLE_LABELS}
          current={current.requestStyle}
          note="Both send the same request and show the same day count. Only the layout on Home changes."
        />
        <ChoiceCards
          legend="Layout (trial)"
          name="layout"
          keys={LAYOUTS}
          labels={LAYOUT_LABELS}
          current={current.layout}
          note="Try one for a while, then switch back. Every screen keeps the same actions; only spacing, shape and navigation change."
        />
      </ActionForm>
    </section>
  );
}
