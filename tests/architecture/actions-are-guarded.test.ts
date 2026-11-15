import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
import { hasDirective, listFiles, read } from "./files";
import { take } from "../support/present";

/**
 * F6: every exported server action runs through the authenticated pipeline
 * (`src/app/_lib/server-action.ts`, `src/app/admin/admin-action.ts`), which resolves the
 * session, validates input with zod and maps errors. Server actions are public POST
 * endpoints, so one that skips it is reachable without a session.
 */
const PIPELINE = /\b(runFormAction|runStateAction|runActionThenGo|adminAction|adminActionThenGo|adminRevealAction|adminStateAction)\s*[(<]/;

/** Actions whose credential is a signed token the service checks, not a session. */
const TOKEN_ACTIONS: Record<string, string> = {
  "src/app/approve/[token]/actions.ts#approveFromEmailAction": "the signed email-approval token (approveFromEmail checks it)",
  "src/app/setup/actions.ts#runSetupAction": "the one-time setup token (runFirstInstall checks it)",
};

/** Files with "use server" that only hold the pipeline itself. */
const PIPELINE_FILES = new Set(["src/app/_lib/server-action.ts", "src/app/admin/admin-action.ts"]);

type ExportedFunction = { name: string; body: string };

/**
 * Exports the scan cannot see into: `export { x } from`, `export { x }`, `export *`
 * and `export default`. An action file defines its actions in place, so any of these
 * is reported rather than trusted.
 */
function opaqueExports(path: string, source: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  return file.statements.flatMap((statement) => {
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) return [`${path}: ${statement.getText(file).split("\n")[0]}`];
    if (ts.isExportAssignment(statement)) return [`${path}: export default`];
    const isDefault =
      ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    return isDefault ? [`${path}: export default`] : [];
  });
}

/** Exported functions of a module: `export async function x`, and `export const x = …` arrows or calls. */
function exportedFunctions(path: string, source: string): ExportedFunction[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const out: ExportedFunction[] = [];
  const exported = (node: ts.Node) =>
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && exported(statement) && statement.name) {
      out.push({ name: statement.name.text, body: statement.body?.getText(file) ?? "" });
    } else if (ts.isVariableStatement(statement) && exported(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) out.push({ name: decl.name.text, body: decl.initializer.getText(file) });
      }
    }
  }
  return out;
}

const actionFiles = () =>
  listFiles("src", /\.tsx?$/).filter((path) => !PIPELINE_FILES.has(path) && hasDirective(read(path), "use server"));

test("the scan finds the app's server actions", () => {
  const count = actionFiles().flatMap((path) => exportedFunctions(path, read(path))).length;
  assert.ok(count >= 50, `expected at least 50 server actions, found ${count}`);
});

test("every exported server action goes through the authenticated pipeline", () => {
  const unguarded = actionFiles().flatMap((path) =>
    exportedFunctions(path, read(path))
      .filter(({ name, body }) => !PIPELINE.test(body) && !TOKEN_ACTIONS[`${path}#${name}`])
      .map(({ name }) => `${path}#${name}`),
  );
  assert.deepEqual(unguarded, [], "Wrap these in runFormAction / runStateAction / adminAction (or record the token they rely on).");
});

test("action files define their actions in place, with no re-export or default export", () => {
  assert.deepEqual(actionFiles().flatMap((path) => opaqueExports(path, read(path))), []);
});

test("every allow-listed token action still exists", () => {
  for (const key of Object.keys(TOKEN_ACTIONS)) {
    const [path, name] = take(key.split("#"), 2);
    assert.ok(exportedFunctions(path, read(path)).some((fn) => fn.name === name), `${key} is gone; drop it from TOKEN_ACTIONS`);
  }
});
