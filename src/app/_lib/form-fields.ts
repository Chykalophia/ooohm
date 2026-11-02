import { z } from "zod";

/** Form field schemas. Browsers send every field as a string; a checkbox only when ticked. */
export const formFields = {
  text: (max: number) => z.string().max(max),
  id: z.string().min(1).max(100),
  /** A select whose empty option means "none". */
  optionalId: z
    .string()
    .max(100)
    .optional()
    .transform((v) => (v ? v : null)),
  checkbox: z
    .string()
    .optional()
    .transform((v) => v === "on"),
  /** A number field; blank means "none". */
  optionalNumber: z
    .string()
    .max(20)
    .optional()
    .transform((v, ctx) => {
      const trimmed = v?.trim() ?? "";
      if (trimmed === "") return null;
      const n = Number(trimmed);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: "custom", message: "Not a number" });
        return z.NEVER;
      }
      return n;
    }),
  number: z
    .string()
    .max(20)
    .transform((v, ctx) => {
      const n = v.trim() === "" ? Number.NaN : Number(v);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: "custom", message: "Not a number" });
        return z.NEVER;
      }
      return n;
    }),
};
