import { describe, expect, it } from "vitest";

import {
  ATTACHED_HEADING,
  ATTACHED_IMAGES_NOTE,
  IMAGES_ONLY_REQUEST,
  composeTurnInput,
  parseTurnInput,
} from "./turn-input";

const shot = { name: "IMG_0042.jpg", path: "/mend/harness-home/paste/20260927-101500-3f9a.jpg" };
const second = { name: "image 2.jpg", path: "/mend/harness-home/paste/20260927-101502-77c1.jpg" };

describe("composeTurnInput", () => {
  it("is the trimmed text alone when nothing is attached", () => {
    expect(composeTurnInput("  fix the header \n", [])).toBe("fix the header");
  });

  it("names every image by its workspace path, the way a Slack turn does", () => {
    expect(composeTurnInput("the header overlaps", [shot, second])).toBe(
      [
        "the header overlaps",
        [
          ATTACHED_HEADING,
          `[image: IMG_0042.jpg · ${shot.path}]`,
          `[image: image 2.jpg · ${second.path}]`,
        ].join("\n"),
        ATTACHED_IMAGES_NOTE,
      ].join("\n\n"),
    );
  });

  it("says where the request is when the message is only images", () => {
    expect(composeTurnInput("   ", [shot]).startsWith(`${IMAGES_ONLY_REQUEST}\n\n`)).toBe(true);
  });

  it("keeps a name from breaking the line", () => {
    const input = composeTurnInput("x", [{ name: "a · b [c]\nd.jpg", path: shot.path }]);
    expect(input).toContain(`[image: a b c d.jpg · ${shot.path}]`);
    expect(parseTurnInput(input).images).toEqual([{ name: "a b c d.jpg", path: shot.path }]);
  });
});

describe("parseTurnInput", () => {
  it("reads back what composeTurnInput wrote", () => {
    const text = "first line\n\nsecond paragraph";
    expect(parseTurnInput(composeTurnInput(text, [shot, second]))).toEqual({
      text,
      images: [shot, second],
    });
  });

  it("reads an images-only message back as no text", () => {
    expect(parseTurnInput(composeTurnInput("", [shot]))).toEqual({ text: "", images: [shot] });
  });

  it("leaves any other turn as text", () => {
    const plain = "just words";
    expect(parseTurnInput(plain)).toEqual({ text: plain, images: [] });
    const quoted = `${ATTACHED_HEADING}\n[image: x · /y]`;
    expect(parseTurnInput(quoted)).toEqual({ text: quoted, images: [] });
  });

  it("leaves text alone when a line under the heading is not an image line", () => {
    const odd = [
      "hello",
      [ATTACHED_HEADING, `[image: x · /y]`, "not an image"].join("\n"),
      ATTACHED_IMAGES_NOTE,
    ].join("\n\n");
    expect(parseTurnInput(odd)).toEqual({ text: odd, images: [] });
  });
});
