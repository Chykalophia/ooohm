import type { LogoRef } from "@/domain/company-logo";
import { OHM_OFFSET, OHM_PATH, OHM_SCALE, OHM_STROKE_WIDTH } from "@/lib/brand-mark";

/** The Ω mark on its accent tile, the same drawing as the favicon. Sized by the text around it. */
export function OhmMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={`h-[1.15em] w-[1.15em] shrink-0 ${className}`}>
      <rect width="32" height="32" rx="7" className="fill-accent" />
      <g transform={`translate(${OHM_OFFSET} ${OHM_OFFSET}) scale(${OHM_SCALE})`}>
        <path
          d={OHM_PATH}
          fill="none"
          className="stroke-accent-foreground"
          strokeWidth={OHM_STROKE_WIDTH}
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}

/** Mark and wordmark: the "OOO" carries the meaning, the "hm" sits quietly beside it. */
export function Logo({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-[0.4em] text-xl font-semibold tracking-tight ${className}`}
      aria-label="OOOhm"
      role="img"
    >
      <OhmMark />
      <span>
        <span className="text-accent-ink">OOO</span>
        <span className="text-muted font-normal">hm</span>
      </span>
    </span>
  );
}

/**
 * The company's own logo, sized by the text around it like {@link Logo}: 1.6em high (32px
 * in the header), its shape kept, never wider than 6em (120px). Its alt text is the company's name.
 */
export function CompanyLogo({ logo, className = "" }: { logo: LogoRef; className?: string }) {
  return (
    // A plain <img>: the file is already small, served from its own cached route, and has to work in every theme.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={logo.src}
      alt={logo.alt}
      width={logo.width}
      height={logo.height}
      className={`block h-[1.6em] w-auto max-w-[6em] object-contain ${className}`}
    />
  );
}

/** The company's logo when an admin set one, otherwise the OOOhm logo. */
export function BrandLogo({ logo, className = "" }: { logo: LogoRef | null; className?: string }) {
  if (!logo) return <Logo className={className} />;
  return (
    <span className={`inline-flex items-center text-xl ${className}`}>
      <CompanyLogo logo={logo} />
    </span>
  );
}
