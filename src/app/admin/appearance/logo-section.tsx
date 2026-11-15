import { LOGO_RULES, LOGO_TYPES, type LogoRef } from "@/shared/kernel/company-logo";
import { ActionForm } from "@/components/forms/action-form";
import { InlineAction } from "@/components/forms/inline-action";
import { CompanyLogo, Logo } from "@/components/layout/logo";
import { TextField } from "@/components/ui/fields";
import { card, cx, focusRing, outlineButton } from "@/components/ui/styles";
import { removeLogoAction, uploadLogoAction } from "./actions";

/** The company logo: a preview, upload or replace, and remove. */
export function LogoSection({ logo }: { logo: LogoRef | null }) {
  return (
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
  );
}
