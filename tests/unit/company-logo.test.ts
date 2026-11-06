import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LOGO_MAX_BYTES,
  LOGO_MAX_SIDE,
  companyLogoPath,
  fitLogo,
  readLogoImage,
  readStoredLogo,
} from "@/domain/company-logo";
import { isDomainError } from "@/domain/errors";
import { jpegHeader, pngImage } from "../support/images";

const invalid = (fn: () => unknown) => assert.throws(fn, (err) => isDomainError(err, "invalid_input"));
const SHA = "a".repeat(64);

test("company logo: PNG and JPEG files are read by their bytes, not their names", () => {
  assert.deepEqual(readLogoImage(pngImage(400, 100)), { contentType: "image/png", width: 400, height: 100 });
  assert.deepEqual(readLogoImage(jpegHeader(120, 80)), { contentType: "image/jpeg", width: 120, height: 80 });
  assert.deepEqual(readLogoImage(jpegHeader(64, 64, { progressive: true })), { contentType: "image/jpeg", width: 64, height: 64 });
});

test("company logo: anything else is refused", () => {
  invalid(() => readLogoImage(new Uint8Array()));
  invalid(() => readLogoImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>")));
  invalid(() => readLogoImage(new TextEncoder().encode("GIF89a\x01\x00\x01\x00")));
  invalid(() => readLogoImage(pngImage(400, 100).slice(0, 20)));
  invalid(() => readLogoImage(jpegHeader(10, 10).slice(0, 8)));
  invalid(() => readLogoImage(pngImage(0, 100)));
  invalid(() => readLogoImage(pngImage(LOGO_MAX_SIDE + 1, 100)));
  invalid(() => readLogoImage(jpegHeader(100, LOGO_MAX_SIDE + 1)));
  const huge = new Uint8Array(LOGO_MAX_BYTES + 1);
  huge.set(pngImage(400, 100));
  invalid(() => readLogoImage(huge));
});

test("company logo: the refusal says what a logo may be", () => {
  assert.throws(
    () => readLogoImage(new TextEncoder().encode("<svg/>")),
    (err) => isDomainError(err, "invalid_input") && /PNG or JPEG/.test((err as Error).message),
  );
});

test("company logo: fitted into a box, keeping its shape", () => {
  assert.deepEqual(fitLogo({ width: 400, height: 100 }, { maxWidth: 200, maxHeight: 32 }), { width: 128, height: 32 });
  assert.deepEqual(fitLogo({ width: 1000, height: 100 }, { maxWidth: 200, maxHeight: 32 }), { width: 200, height: 20 });
  assert.deepEqual(fitLogo({ width: 50, height: 50 }, { maxWidth: 200, maxHeight: 32 }), { width: 32, height: 32 });
  assert.deepEqual(fitLogo({ width: 20, height: 10 }, { maxWidth: 200, maxHeight: 32 }), { width: 20, height: 10 }, "never enlarged");
  assert.deepEqual(fitLogo({ width: 4000, height: 1 }, { maxWidth: 200, maxHeight: 32 }), { width: 200, height: 1 }, "never 0 high");
});

test("company logo: stored columns read back safely, and the path names its content", () => {
  const stored = { logoSha256: SHA, logoType: "image/png", logoWidth: 400, logoHeight: 100 };
  assert.deepEqual(readStoredLogo(stored), { sha256: SHA, contentType: "image/png", width: 400, height: 100 });
  assert.equal(readStoredLogo({ ...stored, logoSha256: null }), null);
  assert.equal(readStoredLogo({ ...stored, logoType: "image/svg+xml" }), null, "a type this version does not serve is no logo");
  assert.equal(readStoredLogo({ ...stored, logoWidth: null }), null);
  assert.equal(readStoredLogo({ ...stored, logoSha256: "nope" }), null);
  assert.equal(companyLogoPath({ sha256: SHA, contentType: "image/png" }), `/logo/${SHA}.png`);
  assert.equal(companyLogoPath({ sha256: SHA, contentType: "image/jpeg" }), `/logo/${SHA}.jpg`);
});
