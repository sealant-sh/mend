import { describe, expect, it } from "vitest";

import {
  COMPOSER_LINE_HEIGHT,
  COMPOSER_MAX_LINES,
  MAX_IMAGES_PER_MESSAGE,
  attachmentsReducer,
  base64ByteLength,
  composerInputHeight,
  composerInputScrolls,
  composerReadiness,
  fitWithin,
  imageName,
  readinessHint,
  storedImages,
  type Attachment,
  type AttachmentEvent,
} from "./composer";

const run = (events: ReadonlyArray<AttachmentEvent>, from: ReadonlyArray<Attachment> = []) =>
  events.reduce(attachmentsReducer, from);

const added = (id: string): AttachmentEvent => ({
  type: "added",
  id,
  uri: `file:///${id}.jpg`,
  name: `${id}.jpg`,
});

describe("attachmentsReducer", () => {
  it("walks one image from preparing to stored", () => {
    const state = run([
      added("a"),
      { type: "prepared", id: "a" },
      { type: "progress", id: "a", sent: 0.4 },
      { type: "stored", id: "a", path: "/p/a.jpg", bytes: 1200 },
    ]);
    expect(state).toEqual([
      {
        id: "a",
        uri: "file:///a.jpg",
        name: "a.jpg",
        phase: { kind: "stored", path: "/p/a.jpg", bytes: 1200 },
      },
    ]);
  });

  it("never lets progress run backwards or past done", () => {
    const state = run([
      added("a"),
      { type: "prepared", id: "a" },
      { type: "progress", id: "a", sent: 0.7 },
      { type: "progress", id: "a", sent: 0.3 },
      { type: "progress", id: "a", sent: 4 },
    ]);
    expect(state[0]?.phase).toEqual({ kind: "uploading", sent: 1 });
  });

  it("ignores events that arrive for a phase the image has left", () => {
    const stored = run([
      added("a"),
      { type: "prepared", id: "a" },
      { type: "stored", id: "a", path: "/p/a.jpg", bytes: 1 },
    ]);
    expect(run([{ type: "progress", id: "a", sent: 0.5 }], stored)).toBe(stored);
    expect(run([{ type: "failed", id: "a", message: "late" }], stored)).toBe(stored);
    expect(run([{ type: "prepared", id: "a" }], stored)).toBe(stored);
    // Stored straight from preparing skips the upload: refused.
    const preparing = run([added("b")]);
    expect(run([{ type: "stored", id: "b", path: "/p", bytes: 1 }], preparing)).toBe(preparing);
  });

  it("drops what finishes after the image was removed", () => {
    const state = run([
      added("a"),
      { type: "prepared", id: "a" },
      { type: "removed", id: "a" },
      { type: "stored", id: "a", path: "/p/a.jpg", bytes: 1 },
    ]);
    expect(state).toEqual([]);
  });

  it("retries a failed image from the start, and only a failed one", () => {
    const failed = run([
      added("a"),
      { type: "prepared", id: "a" },
      { type: "failed", id: "a", message: "offline" },
    ]);
    expect(failed[0]?.phase).toEqual({ kind: "failed", message: "offline" });
    expect(run([{ type: "retried", id: "a" }], failed)[0]?.phase).toEqual({ kind: "preparing" });
    const uploading = run([added("b"), { type: "prepared", id: "b" }]);
    expect(run([{ type: "retried", id: "b" }], uploading)).toBe(uploading);
  });

  it("holds at most the images one message carries, and each id once", () => {
    const ids = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 2 }, (_, index) => `i${index}`);
    expect(run(ids.map(added))).toHaveLength(MAX_IMAGES_PER_MESSAGE);
    expect(run([added("a"), added("a")])).toHaveLength(1);
  });

  it("clears on send and restores a message that did not send", () => {
    const stored = run([
      added("a"),
      { type: "prepared", id: "a" },
      { type: "stored", id: "a", path: "/p/a.jpg", bytes: 1 },
    ]);
    expect(run([{ type: "cleared" }], stored)).toEqual([]);
    expect(run([{ type: "restored", attachments: stored }], [])).toEqual(stored);
    // Restoring what the composer already holds adds nothing.
    expect(run([{ type: "restored", attachments: stored }], stored)).toBe(stored);
  });
});

describe("storedImages", () => {
  it("is the stored images in attach order, without the ones still going up", () => {
    const state = run([
      added("a"),
      added("b"),
      added("c"),
      { type: "prepared", id: "c" },
      { type: "stored", id: "c", path: "/p/c.jpg", bytes: 1 },
      { type: "prepared", id: "a" },
      { type: "stored", id: "a", path: "/p/a.jpg", bytes: 1 },
    ]);
    expect(storedImages(state).map((image) => image.path)).toEqual(["/p/a.jpg", "/p/c.jpg"]);
  });
});

const at = (attachments: ReadonlyArray<Attachment>) =>
  composerReadiness({ draft: "hi", attachments, starting: false });

describe("composerReadiness", () => {
  const stored = run([
    added("a"),
    { type: "prepared", id: "a" },
    { type: "stored", id: "a", path: "/p/a.jpg", bytes: 1 },
  ]);

  it("sends text, images, or both — never nothing", () => {
    expect(composerReadiness({ draft: "  ", attachments: [], starting: false })).toEqual({
      canSend: false,
      reason: "empty",
    });
    expect(composerReadiness({ draft: "hi", attachments: [], starting: false }).canSend).toBe(true);
    expect(composerReadiness({ draft: "", attachments: stored, starting: false }).canSend).toBe(
      true,
    );
  });

  it("waits for every image, and refuses to drop a failed one silently", () => {
    const preparing = run([added("b")], stored);
    const uploading = run([{ type: "prepared", id: "b" }], preparing);
    const failed = run([{ type: "failed", id: "b", message: "x" }], uploading);
    expect(at(preparing)).toEqual({ canSend: false, reason: "preparing" });
    expect(at(uploading)).toEqual({ canSend: false, reason: "uploading" });
    expect(at(failed)).toEqual({ canSend: false, reason: "failed" });
    expect(readinessHint(at(failed), 2)).toBe(
      "an image did not upload · tap it to retry, or remove it",
    );
    expect(readinessHint(at(uploading), 1)).toBe("uploading the image…");
  });

  it("waits for the agent to start", () => {
    expect(composerReadiness({ draft: "hi", attachments: [], starting: true })).toEqual({
      canSend: false,
      reason: "starting",
    });
  });
});

describe("composerInputHeight", () => {
  const max = COMPOSER_LINE_HEIGHT * COMPOSER_MAX_LINES;

  it("is one line when empty, whatever height iOS last reported", () => {
    expect(composerInputHeight("", 180)).toBe(COMPOSER_LINE_HEIGHT);
    expect(composerInputScrolls("", 400)).toBe(false);
  });

  it("follows the text between one line and the maximum, then scrolls", () => {
    expect(composerInputHeight("a", 12)).toBe(COMPOSER_LINE_HEIGHT);
    expect(composerInputHeight("a\nb\nc", 59.4)).toBe(60);
    expect(composerInputHeight("long", 500)).toBe(max);
    expect(composerInputScrolls("long", 500)).toBe(true);
    expect(composerInputScrolls("short", 40)).toBe(false);
  });
});

describe("image sizing", () => {
  it("scales the long edge down to the limit and keeps the ratio", () => {
    expect(fitWithin(4032, 3024, 2048)).toEqual({ width: 2048, height: 1536 });
    expect(fitWithin(1179, 2556, 2048)).toEqual({ width: 945, height: 2048 });
    expect(fitWithin(1200, 800, 2048)).toBeNull();
    expect(fitWithin(0, 0, 2048)).toBeNull();
  });

  it("counts the bytes a base64 string decodes to", () => {
    expect(base64ByteLength("")).toBe(0);
    expect(base64ByteLength("iVBORw0KGgo=")).toBe(8);
    expect(base64ByteLength("YQ==")).toBe(1);
    expect(base64ByteLength("YWJj")).toBe(3);
  });

  it("names the image as the JPEG it becomes", () => {
    expect(imageName("IMG_0042.HEIC", 1)).toBe("IMG_0042.jpg");
    expect(imageName(null, 3)).toBe("image 3.jpg");
    expect(imageName("", 2)).toBe("image 2.jpg");
  });
});
