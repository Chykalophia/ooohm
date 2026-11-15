"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { isDomainError } from "@/domain/errors";
import { importPeople, previewPeopleImport } from "@/modules/people";
import { unwrap } from "@/shared/lib/result";
import { adminStateAction } from "@/app/admin/admin-action";
import { formFields } from "@/app/_lib/form-fields";
import { importedState, MAX_FILE_BYTES, previewState, readUpload, refusalOf } from "./import-outcome";
import type { ImportState } from "./import-state";

const importSchema = z.object({
  intent: z.enum(["check", "import"]),
  file: z.instanceof(File).optional(),
  csv: z.string().max(MAX_FILE_BYTES).optional(),
  fileName: formFields.text(300).optional(),
  sendInvites: formFields.checkbox,
});

/**
 * Import page. `check` reads the uploaded file and returns what importing it would do,
 * writing nothing; `import` imports the checked file (sent back as text), planning it
 * again first. A refused import comes back as a fresh check that says why.
 */
export async function peopleImportAction(_prev: ImportState, formData: FormData): Promise<ImportState> {
  return adminStateAction(
    "people_import",
    formData,
    importSchema,
    async (ctx, actor, input): Promise<ImportState> => {
      const upload = input.intent === "check" ? await readUpload(input.file) : { csv: input.csv ?? "", fileName: input.fileName ?? "" };
      if ("status" in upload) return upload;
      const { csv, fileName } = upload;
      const check = async (problem?: string) => previewState(unwrap(await previewPeopleImport(ctx, actor, csv)), csv, fileName, problem);

      try {
        if (input.intent === "check") return await check();
        const result = unwrap(await importPeople(ctx, actor, { csv, sendInvites: input.sendInvites }));
        // The page keeps showing the outcome; this only drops cached copies of other
        // pages (People), so going back shows the new people.
        refresh();
        return importedState(result, input.sendInvites);
      } catch (err) {
        const message = isDomainError(err) ? refusalOf(err) : null;
        if (message === null) throw err;
        if (input.intent === "check") return { status: "error", message, fields: ["file"] };
        return check(message).catch((recheck: unknown) => {
          if (!isDomainError(recheck)) throw recheck;
          return { status: "error", message } as const;
        });
      }
    },
  );
}
