import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, test } from "node:test";
import ts from "typescript";
import { listFiles, ROOT } from "./files";

/**
 * F11 (docs/architecture-plan/04-fitness-functions.md, ADR-0009): a module's public API
 * (`src/modules/<m>/index.ts`) never hands out a database row. No export may be named
 * `…Row`, come from the module's `infrastructure/`, or be a type built on a Drizzle
 * table's `$inferSelect` / `InferSelectModel`.
 */

/** Whether a type node, or any type alias it names (followed through every file), mentions a Drizzle row type. */
function mentionsInferSelect(checker: ts.TypeChecker, node: ts.Node, seen = new Set<ts.Node>()): boolean {
  if (seen.has(node)) return false;
  seen.add(node);
  if (/\$inferSelect|InferSelectModel/.test(node.getText())) return true;
  let found = false;
  const visit = (child: ts.Node) => {
    if (found) return;
    if (ts.isTypeReferenceNode(child) || ts.isTypeQueryNode(child)) {
      const name = ts.isTypeReferenceNode(child) ? child.typeName : child.exprName;
      let symbol = checker.getSymbolAtLocation(name);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      for (const decl of symbol?.declarations ?? []) {
        if (decl.getSourceFile().isDeclarationFile) continue;
        const inner = ts.isTypeAliasDeclaration(decl) ? decl.type : ts.isInterfaceDeclaration(decl) ? decl : null;
        if (inner && mentionsInferSelect(checker, inner, seen)) found = true;
      }
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

/** Every export of each index file that breaks F11, as "<index>: <export> (<why>)". */
export function rowExports(program: ts.Program, indexFiles: readonly string[]): string[] {
  const checker = program.getTypeChecker();
  const problems: string[] = [];
  for (const file of indexFiles) {
    const source = program.getSourceFile(file);
    assert.ok(source, `${file} is not in the program`);
    const moduleSymbol = checker.getSymbolAtLocation(source);
    if (!moduleSymbol) continue;
    const label = relative(ROOT, file).split("\\").join("/");
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const name = exported.getName();
      const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      const decls = target.declarations ?? [];
      if (/Row$/.test(name)) problems.push(`${label}: ${name} (named like a row)`);
      if (decls.some((d) => /\/infrastructure\//.test(d.getSourceFile().fileName.split("\\").join("/")))) {
        problems.push(`${label}: ${name} (from infrastructure/)`);
      }
      for (const decl of decls) {
        const typeNode = ts.isTypeAliasDeclaration(decl) ? decl.type : ts.isInterfaceDeclaration(decl) ? decl : null;
        if (typeNode && mentionsInferSelect(checker, typeNode)) problems.push(`${label}: ${name} (a Drizzle $inferSelect type)`);
      }
    }
  }
  return problems;
}

function programFor(rootNames: string[]): ts.Program {
  const config = ts.getParsedCommandLineOfConfigFile(join(ROOT, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  assert.ok(config, "tsconfig.json did not parse");
  return ts.createProgram({ rootNames, options: { ...config.options, noEmit: true } });
}

const fixtures: string[] = [];
after(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

test("the check reports a Row name, an infrastructure re-export and an $inferSelect type", () => {
  const dir = mkdtempSync(join(tmpdir(), "no-rows-"));
  fixtures.push(dir);
  const files: Record<string, string> = {
    "probe/infrastructure/repo.ts": "export const findThing = () => 1;\n",
    "probe/application/dto.ts": [
      "declare const things: { $inferSelect: { id: string; secret: string } };",
      "type Selected = typeof things.$inferSelect;",
      "export type ThingDTO = { id: string };",
      "export type LeakyDTO = Pick<Selected, 'id'>;",
      "export type ThingRow = { id: string };",
    ].join("\n"),
    "probe/index.ts": [
      'export { findThing } from "./infrastructure/repo";',
      'export type { LeakyDTO, ThingDTO, ThingRow } from "./application/dto";',
    ].join("\n"),
  };
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), source);
  }
  const index = join(dir, "probe/index.ts");
  const problems = rowExports(programFor([index]), [index]).map((p) => p.replace(/^[^:]+: /, ""));
  assert.deepEqual(problems.sort(), [
    "LeakyDTO (a Drizzle $inferSelect type)",
    "ThingRow (named like a row)",
    "findThing (from infrastructure/)",
  ]);
});

test("no module's index.ts exports a row type or anything from infrastructure/", () => {
  const indexes = listFiles("src/modules", /^index\.ts$/)
    .filter((path) => /^src\/modules\/[^/]+\/index\.ts$/.test(path))
    .map((path) => join(ROOT, path));
  assert.ok(indexes.length >= 2, `expected the module index files, found ${indexes.length}`);
  assert.deepEqual(rowExports(programFor(indexes), indexes), []);
});
