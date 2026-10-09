import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { HARNESS_HOME_MOUNT_PATH } from "./harness-state.ts";
import {
  PASTED_IMAGE_MAX_BYTES,
  detectImageType,
  pastedImageName,
  pastedImagePlacement,
  storePastedImage,
} from "./pasted-images.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38,
]);

const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "mend-paste-"));

describe("detectImageType", () => {
  it("recognises the four accepted formats by signature", () => {
    expect(detectImageType(PNG)).toBe("image/png");
    expect(detectImageType(JPEG)).toBe("image/jpeg");
    expect(detectImageType(GIF)).toBe("image/gif");
    expect(detectImageType(WEBP)).toBe("image/webp");
  });

  it("rejects anything else — a RIFF that is not WebP included", () => {
    expect(detectImageType(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeNull();
    expect(detectImageType(new TextEncoder().encode("RIFF....WAVE"))).toBeNull();
    expect(detectImageType(new Uint8Array())).toBeNull();
  });
});

describe("pastedImageName", () => {
  it("stamps local time, the nonce, and the format's extension", () => {
    expect(pastedImageName("image/jpeg", new Date(2026, 8, 2, 14, 30, 12), "3f9a")).toBe(
      "20260902-143012-3f9a.jpg",
    );
  });
});

describe("storePastedImage", () => {
  it("writes under paste/ and answers with the workspace path", async () => {
    const home = tempHome();
    const stored = await Effect.runPromise(
      storePastedImage(home, PNG, { now: new Date(2026, 8, 2, 14, 30, 12), nonce: "abcd" }),
    );
    expect(stored.path).toBe(`${HARNESS_HOME_MOUNT_PATH}/paste/20260902-143012-abcd.png`);
    expect(stored.hostPath).toBe(path.join(home, "paste", "20260902-143012-abcd.png"));
    expect(stored.mediaType).toBe("image/png");
    expect(stored.bytes).toBe(PNG.byteLength);
    expect(new Uint8Array(fs.readFileSync(stored.hostPath))).toEqual(PNG);
    // Readable by the workspace uid, whatever it is.
    expect(fs.statSync(stored.hostPath).mode & 0o044).toBe(0o044);
  });

  it("creates the harness home when the session has not launched yet", async () => {
    const home = path.join(tempHome(), "sessions", "s1", "harness-home");
    const stored = await Effect.runPromise(storePastedImage(home, GIF));
    expect(fs.existsSync(stored.hostPath)).toBe(true);
  });

  it("refuses bytes that are not an image, writing nothing", async () => {
    const home = tempHome();
    const result = await Effect.runPromise(
      Effect.result(storePastedImage(home, new TextEncoder().encode("hello"))),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.reason).toBe("not-an-image");
    expect(fs.existsSync(path.join(home, "paste"))).toBe(false);
  });

  it("refuses an image over the cap before looking at the bytes", async () => {
    const home = tempHome();
    const huge = new Uint8Array(PASTED_IMAGE_MAX_BYTES + 1);
    huge.set(PNG);
    const result = await Effect.runPromise(Effect.result(storePastedImage(home, huge)));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.reason).toBe("too-large");
  });

  it("refuses a paste directory the workspace made a link out of the harness home (mend#597 review, finding 2)", async () => {
    const home = tempHome();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mend-paste-outside-"));
    fs.chmodSync(outside, 0o700);
    fs.symlinkSync(outside, path.join(home, "paste"));
    const result = await Effect.runPromise(Effect.result(storePastedImage(home, PNG)));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.reason).toBe("write-failed");
      expect(result.failure.message).toBe(`Could not store the image: a link: ${home}/paste`);
    }
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.statSync(outside).mode & 0o7777).toBe(0o700);
  });

  it("leaves the mode of a paste directory already there as it is", async () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, "paste"));
    fs.chmodSync(path.join(home, "paste"), 0o750);
    const stored = await Effect.runPromise(storePastedImage(home, PNG));
    expect(fs.statSync(path.join(home, "paste")).mode & 0o7777).toBe(0o750);
    expect(fs.statSync(stored.hostPath).mode & 0o777).toBe(0o644);
  });
});

describe("pastedImagePlacement", () => {
  it("keeps a shared executor's paste where it was, inside the harness home", () => {
    expect(pastedImagePlacement("a.png", null)).toEqual({
      path: `${HARNESS_HOME_MOUNT_PATH}/paste/a.png`,
      within: { root: HARNESS_HOME_MOUNT_PATH, directoryMode: 0o755, fileMode: 0o644 },
    });
  });

  it("puts a person's paste in their own saved directory, the group's to read", () => {
    expect(pastedImagePlacement("a.png", "user-maria")).toEqual({
      path: `${HARNESS_HOME_MOUNT_PATH}/people/user-maria/paste/a.png`,
      within: {
        root: `${HARNESS_HOME_MOUNT_PATH}/people/user-maria`,
        directoryMode: 0o2770,
        fileMode: 0o640,
      },
    });
  });
});
