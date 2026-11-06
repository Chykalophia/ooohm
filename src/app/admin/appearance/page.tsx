import type { Metadata } from "next";
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
  readAppearance,
} from "@/domain/appearance";
import { LOGO_RULES, LOGO_TYPES, appLogoRef, readStoredLogo } from "@/domain/company-logo";
import { getCompanySettings } from "@/server/services/admin-company";
import { AdminShell } from "@/app/admin/admin-shell";
import { requireAdminPage } from "@/app/_lib/page-context";
import { ActionForm } from "@/components/forms/action-form";
import { InlineAction } from "@/components/forms/inline-action";
import { CompanyLogo, Logo } from "@/components/layout/logo";
import { CheckboxField, SelectField, TextField } from "@/components/ui/fields";
import { card, cx, focusRing, outlineButton } from "@/components/ui/styles";
import { removeLogoAction, updateAppearanceAction, uploadLogoAction } from "@/app/admin/appearance/actions";

export const metadata: Metadata = { title: "Appearance · Admin · OOOhm" };

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

export default async function AppearancePage() {
  const { actor, ctx, nav } = await requireAdminPage();
  const { company } = await getCompanySettings(ctx, actor);
  const current = readAppearance(company);
  const stored = readStoredLogo(company);
  const logo = stored ? appLogoRef(stored, company.name) : null;

  return (
    <AdminShell
      nav={nav}
      section="appearance"
      title="Appearance"
      description="Choose how OOOhm looks for everyone in your company. People can’t change it for themselves, so pick what fits your team."
    >
      <section aria-labelledby="logo-heading" className={cx(card, "mb-6 space-y-4")}>
        <div className="space-y-1">
          <h2 id="logo-heading" className="text-sm font-medium">
            Logo
          </h2>
          <p className="text-xs text-muted">
            Shown instead of the OOOhm logo in the header, on the sign-in page and at the top of emails. {LOGO_RULES} A wide logo on a
            transparent background reads best in light and dark mode.
          </p>
        </div>
        <div id="logo-preview" tabIndex={-1} className={cx("flex min-h-14 items-center rounded-xl border border-border px-4 py-3 text-xl", focusRing)}>
          {logo ? <CompanyLogo logo={logo} /> : <Logo />}
          <span className="sr-only">{logo ? "Your logo is set." : "No logo yet: the OOOhm logo shows."}</span>
        </div>
        <ActionForm
          action={uploadLogoAction}
          submitLabel={logo ? "Replace logo" : "Upload logo"}
          pendingLabel="Uploading…"
          resetOnSuccess
          buttonClassName={outlineButton}
          className="space-y-4"
        >
          <TextField label="Logo file" name="logo" type="file" accept={LOGO_TYPES.join(",")} required />
        </ActionForm>
        {logo && (
          <InlineAction
            action={removeLogoAction}
            fields={{}}
            label="Remove logo"
            pendingLabel="Removing…"
            confirm="Remove the logo? The OOOhm logo shows again, and emails already sent show your company’s name instead."
            confirmLabel="Yes, remove it"
            variant="danger"
            // The button goes with the logo: focus the preview, which now reads "No logo yet".
            focusOnSuccess="logo-preview"
          />
        )}
      </section>

      <section aria-label="Appearance settings" className={card}>
        <ActionForm action={updateAppearanceAction} submitLabel="Save appearance" pendingLabel="Saving…" className="space-y-6">
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
                    <input
                      type="radio"
                      name="theme"
                      value={key}
                      defaultChecked={current.theme === key}
                      className="mt-1 accent-[var(--accent)]"
                    />
                    <span>
                      <span className="block text-sm font-medium">{THEMES[key].label}</span>
                      <span className="block text-xs text-muted">{THEMES[key].description}</span>
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <p className="text-xs text-muted">
              Only Classic, with its own accent, has a dark version: there each person’s choice of light, dark or automatic (on their
              account page) applies. The other themes are light only.
            </p>
          </fieldset>

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

          <SelectField
            label="Corners"
            name="corners"
            defaultValue={current.corners}
            options={CORNER_STYLES.map((c) => ({ value: c, label: CORNER_LABELS[c] }))}
            hint="Overrides how rounded cards, fields and buttons are in every theme."
          />

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">How people ask for time off</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {REQUEST_STYLES.map((style) => (
                <label
                  key={style}
                  className="flex cursor-pointer items-start gap-2 rounded-2xl border border-border p-3 has-[:checked]:border-accent has-[:checked]:ring-2 has-[:checked]:ring-accent/30 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/40"
                >
                  <input
                    type="radio"
                    name="requestStyle"
                    value={style}
                    defaultChecked={current.requestStyle === style}
                    className="mt-1 accent-[var(--accent)]"
                  />
                  <span>
                    <span className="block text-sm font-medium">{REQUEST_STYLE_LABELS[style].label}</span>
                    <span className="block text-xs text-muted">{REQUEST_STYLE_LABELS[style].description}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="text-xs text-muted">Both send the same request and show the same day count. Only the layout on Home changes.</p>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Layout (trial)</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {LAYOUTS.map((layout) => (
                <label
                  key={layout}
                  className="flex cursor-pointer items-start gap-2 rounded-2xl border border-border p-3 has-[:checked]:border-accent has-[:checked]:ring-2 has-[:checked]:ring-accent/30 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/40"
                >
                  <input type="radio" name="layout" value={layout} defaultChecked={current.layout === layout} className="mt-1 accent-[var(--accent)]" />
                  <span>
                    <span className="block text-sm font-medium">{LAYOUT_LABELS[layout].label}</span>
                    <span className="block text-xs text-muted">{LAYOUT_LABELS[layout].description}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="text-xs text-muted">Try one for a while, then switch back. Every screen keeps the same actions; only spacing, shape and navigation change.</p>
          </fieldset>
        </ActionForm>
      </section>
    </AdminShell>
  );
}
