import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { removeCompanyLogo, updateCompanyLogo } from "@/server/services/admin-company";
import { getCompanyLogo, getDeploymentLogo } from "@/server/services/appearance";
import { emailAccentFor } from "@/server/services/email-accent";
import { handleLogoFetch } from "@/app/logo/[file]/logo-fetch";
import { jpegHeader, pngImage } from "../support/images";
import { rejectsWith } from "./assertions";
import { companyAudit, companyEvents, seedCompany } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("company logo", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  test("an admin uploads a logo: stored once, audited and announced, then shown in the app and served publicly", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    const ctx = createTestContext(t.db);
    const [{ name }] = await t.db.select({ name: schema.companies.name }).from(schema.companies).where(eq(schema.companies.id, co.companyId));
    assert.equal(await getCompanyLogo(ctx, co.companyId), null, "no logo until one is uploaded");

    const png = pngImage(400, 100);
    const hash = sha(png);
    const saved = await updateCompanyLogo(ctx, co.people.boss, png);
    assert.deepEqual([saved.logoSha256, saved.logoType, saved.logoWidth, saved.logoHeight], [hash, "image/png", 400, 100]);
    await updateCompanyLogo(ctx, co.people.boss, png);

    const audit = await companyAudit(t.db, co.companyId, "company.");
    assert.equal(audit.length, 1, "the same file again records nothing");
    assert.equal(audit[0].actorId, co.people.boss.id);
    assert.equal((audit[0].before as { logo: unknown }).logo, null);
    assert.deepEqual((audit[0].after as { logo: unknown }).logo, { sha256: hash, contentType: "image/png", width: 400, height: 100 });
    const events = await companyEvents(t.db, co.companyId, "company.updated");
    assert.equal(events.length, 1);
    assert.deepEqual((events[0].payload as { logo: unknown }).logo, { sha256: hash, contentType: "image/png", width: 400, height: 100 });

    assert.deepEqual(await getCompanyLogo(ctx, co.companyId), { src: `/logo/${hash}.png`, alt: name, width: 120, height: 30 });
    assert.deepEqual(await getDeploymentLogo(ctx), { src: `/logo/${hash}.png`, alt: name, width: 120, height: 30 });

    const res = await handleLogoFetch({ ctx, file: `${hash}.png` });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("content-security-policy"), "default-src 'none'");
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), png);
  });

  test("emails carry the logo at the app's public URL", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    const ctx = createTestContext(t.db);
    const png = pngImage(100, 100);
    await updateCompanyLogo(ctx, co.people.boss, png);
    const accent = await emailAccentFor(ctx, co.companyId)();
    assert.equal(accent.logo?.src, `https://ooohm.test/logo/${sha(png)}.png`);
    assert.deepEqual([accent.logo?.width, accent.logo?.height], [40, 40]);
  });

  test("a new logo replaces the old one, and removing it goes back to the OOOhm mark", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    const ctx = createTestContext(t.db);
    const first = pngImage(200, 100, [200, 30, 30]);
    const jpeg = jpegHeader(300, 100);
    await updateCompanyLogo(ctx, co.people.boss, first);
    const replaced = await updateCompanyLogo(ctx, co.people.boss, jpeg);
    assert.equal(replaced.logoType, "image/jpeg");
    assert.equal((await handleLogoFetch({ ctx, file: `${sha(first)}.png` })).status, 404, "the old file is gone");
    assert.equal((await handleLogoFetch({ ctx, file: `${sha(jpeg)}.jpg` })).status, 200);

    const removed = await removeCompanyLogo(ctx, co.people.boss);
    assert.equal(removed.logoSha256, null);
    await removeCompanyLogo(ctx, co.people.boss);
    assert.equal(await getCompanyLogo(ctx, co.companyId), null);
    assert.equal((await handleLogoFetch({ ctx, file: `${sha(jpeg)}.jpg` })).status, 404);
    const [{ logo }] = await t.db.select({ logo: schema.companies.logo }).from(schema.companies).where(eq(schema.companies.id, co.companyId));
    assert.equal(logo, null, "the bytes are deleted, not only hidden");

    const audit = await companyAudit(t.db, co.companyId, "company.");
    assert.equal(audit.length, 3, "upload, replace, remove; removing nothing records nothing");
    assert.equal((audit[2].after as { logo: unknown }).logo, null);
    const events = await companyEvents(t.db, co.companyId, "company.updated");
    assert.deepEqual(
      events.map((e) => (e.payload as { logo: { sha256: string } | null }).logo?.sha256 ?? null),
      [sha(first), sha(jpeg), null],
      "upload, replace and remove are each announced once",
    );
  });

  test("the logo route answers a bare 404 for anything but a stored logo", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    const ctx = createTestContext(t.db);
    const png = pngImage(10, 10);
    await updateCompanyLogo(ctx, co.people.boss, png);
    for (const file of [`${sha(png)}.jpg`, sha(png), `${"0".repeat(64)}.png`, "../../etc/passwd", `${sha(png).toUpperCase()}.png`]) {
      const res = await handleLogoFetch({ ctx, file });
      assert.equal(res.status, 404, file);
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
  });

  test("non-admins and files that aren't PNG or JPEG are refused, nothing written", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, mgr: { role: "manager" } });
    const ctx = createTestContext(t.db);
    await rejectsWith(updateCompanyLogo(ctx, co.people.mgr, pngImage(10, 10)), "forbidden");
    await rejectsWith(removeCompanyLogo(ctx, co.people.mgr), "forbidden");
    await rejectsWith(updateCompanyLogo(ctx, co.people.boss, new TextEncoder().encode("<svg onload='alert(1)'/>")), "invalid_input");
    await rejectsWith(updateCompanyLogo(ctx, co.people.boss, new Uint8Array()), "invalid_input");
    assert.deepEqual(await companyAudit(t.db, co.companyId), []);
    assert.equal(await getCompanyLogo(ctx, co.companyId), null);
  });
});
