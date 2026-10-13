import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  COMPOSER_CONTEXT_KINDS,
  ComposerContextRecord,
  OrchestrationMessageContext,
} from "../src/composerContext.ts";

// Literal protocol examples, independent of the codec's output and the vendored test table.
const goldenRecords = [
  {
    version: 1,
    contextId: "ctx_image",
    kind: "image",
    label: "error.png",
    attachmentId: "att_image",
    name: "error.png",
    mimeType: "image/png",
    sizeBytes: 1234,
  },
  {
    version: 1,
    contextId: "ctx_file",
    kind: "file",
    label: "notes.txt",
    attachmentId: "att_file",
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 12,
  },
  {
    version: 1,
    contextId: "ctx_terminal",
    kind: "terminal",
    label: "Build lines 3-4",
    terminalId: "term_build",
    terminalLabel: "Build",
    lineStart: 3,
    lineEnd: 4,
    text: 'error: "missing"\n  at src/main.ts:1\\path',
  },
  {
    version: 1,
    contextId: "ctx_element",
    kind: "element",
    label: "Pay button",
    pageUrl: "http://127.0.0.1:3000/checkout",
    pageTitle: "Checkout",
    tagName: "button",
    selector: "#pay",
    htmlPreview: '<button id="pay">Pay</button>',
    componentName: "Button",
    source: { functionName: "Button", fileName: "Button.tsx", lineNumber: 12, columnNumber: 3 },
    styles: "color: red;",
  },
  {
    version: 1,
    contextId: "ctx_annotation",
    kind: "preview-annotation",
    label: "Checkout",
    annotationId: "ann_checkout",
    pageUrl: "http://127.0.0.1:3000/checkout",
    pageTitle: null,
    comment: "Make this bigger",
    targetSummary: "1 selected element",
    styleChanges: ["font-size: 20px"],
    elements: [
      {
        pageUrl: "http://127.0.0.1:3000/checkout",
        pageTitle: null,
        tagName: "button",
        selector: "#pay",
        htmlPreview: "<button>Pay</button>",
        componentName: null,
        source: null,
        styles: "",
      },
    ],
    elementIds: ["pay"],
    regionCount: 0,
    strokeCount: 1,
    styleChangeDetails: [
      {
        targetId: "pay",
        selector: "#pay",
        property: "font-size",
        previousValue: "16px",
        value: "20px",
      },
    ],
    screenshotContextId: "ctx_image",
  },
  {
    version: 1,
    contextId: "ctx_review",
    kind: "review-comment",
    label: "main.ts L3",
    sectionId: "diff_main",
    sectionTitle: "Changes",
    filePath: "src/main.ts",
    startIndex: 3,
    endIndex: 3,
    rangeLabel: "L3",
    text: "Why is this here?",
    diff: "+ const x = 1;",
    fenceLanguage: "diff",
    pullRequest: {
      number: 42,
      title: "Context chips",
      url: "https://example.test/pull/42",
      headBranch: "feature/context",
      baseBranch: "main",
      state: "open",
      isDraft: false,
    },
  },
  {
    version: 1,
    contextId: "ctx_mention",
    kind: "mention",
    label: "@src/index.ts",
    path: "src/index.ts",
  },
  { version: 1, contextId: "ctx_skill", kind: "skill", label: "$review", name: "review" },
  {
    version: 1,
    contextId: "ctx_thread",
    kind: "thread",
    label: "Fix login",
    environmentId: "environment_1",
    threadId: "thread_1",
    title: "Fix login",
  },
];
const codec = Schema.toCodecJson(ComposerContextRecord);
const decode = Schema.decodeUnknownSync(codec);
const encode = Schema.encodeSync(codec);

describe("local composer JSON wire oracles", () => {
  it("has an independent golden for all nine pinned known kinds", () => {
    expect(goldenRecords.map((record) => record.kind).toSorted()).toEqual([
      "element",
      "file",
      "image",
      "mention",
      "preview-annotation",
      "review-comment",
      "skill",
      "terminal",
      "thread",
    ]);
    expect([...COMPOSER_CONTEXT_KINDS].toSorted()).toEqual(
      goldenRecords.map((record) => record.kind).toSorted(),
    );
  });

  it.each(goldenRecords)("decodes and encodes the exact $kind golden wire", (wire) => {
    const decoded = decode(wire);
    expect(decoded).toEqual(wire);
    expect(encode(decoded)).toEqual(wire);
    expect(JSON.parse(JSON.stringify(encode(decoded)))).toEqual(wire);
  });

  it("preserves all known records in the versioned message-context wire envelope", () => {
    const wire = { version: 1, records: goldenRecords };
    const contextCodec = Schema.toCodecJson(OrchestrationMessageContext);
    const decoded = Schema.decodeUnknownSync(contextCodec)(wire);
    expect(decoded).toEqual(wire);
    expect(Schema.encodeSync(contextCodec)(decoded)).toEqual(wire);
  });

  it.prop(
    "keeps escaped and Unicode labels across JSON wire encoding",
    {
      characters: Schema.Array(Schema.Literals(['"', "\\", "\n", "\t", "λ", "🙂", "x"])).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(24),
      ),
    },
    ({ characters }) => {
      const wire = {
        version: 1,
        contextId: "ctx_strings",
        kind: "skill",
        label: characters.join(""),
        name: "review",
      };
      expect(JSON.parse(JSON.stringify(encode(decode(wire))))).toEqual(wire);
    },
    { arbitrary: { runs: 64, seed: 81903 } },
  );
});
