import { describe, expect, it } from "vitest";

import { scrubEvent, scrubPath, type PathRules } from "./scrub.ts";

const rules: PathRules = {
  appRoot: "/home/ada/.npm-global/lib/node_modules/@sealant/mend",
  homeDir: "/home/ada",
};

describe("a stack frame's file", () => {
  it.each([
    ["/home/ada/.npm-global/lib/node_modules/@sealant/mend/dist/main.js", "app:///dist/main.js"],
    [
      "file:///home/ada/.npm-global/lib/node_modules/@sealant/mend/dist/a%20b.js",
      "app:///dist/a b.js",
    ],
    // A sibling whose name starts with the app's is not inside it.
    [
      "/home/ada/.npm-global/lib/node_modules/@sealant/mend-extra/x.js",
      "~/.npm-global/lib/node_modules/@sealant/mend-extra/x.js",
    ],
    ["/Users/bob/src/thing.js", "~/src/thing.js"],
    ["C:\\Users\\bob\\AppData\\mend.js", "~\\AppData\\mend.js"],
    ["node:internal/process/task_queues", "node:internal/process/task_queues"],
    ["/usr/lib/node_modules/undici/index.js", "/usr/lib/node_modules/undici/index.js"],
  ])("%s reads %s", (path, expected) => {
    expect(scrubPath(path, rules)).toBe(expected);
  });
});

describe("an error event", () => {
  it("keeps only what a report may carry", () => {
    const event = {
      event_id: "e1",
      release: "mend-cli@1.2.3",
      server_name: "ada-laptop",
      user: { ip_address: "10.0.0.2" },
      request: { url: "https://mend.example.com/?token=t", data: "a prompt" },
      breadcrumbs: [{ message: "a prompt" }],
      extra: { body: "a prompt" },
      contexts: {
        trace: { trace_id: "a".repeat(32), span_id: "b".repeat(16), data: { prompt: "a prompt" } },
        device: { name: "Ada's phone" },
      },
      exception: {
        values: [
          {
            type: "Error",
            value: "boom",
            mechanism: { type: "generic", handled: true, data: { prompt: "a prompt" } },
            stacktrace: {
              frames: [
                {
                  filename: "/home/ada/.npm-global/lib/node_modules/@sealant/mend/dist/main.js",
                  lineno: 3,
                  context_line: "const token = 'secret'",
                  vars: { token: "secret" },
                },
              ],
            },
          },
        ],
      },
    };
    expect(scrubEvent(event, rules)).toStrictEqual({
      event_id: "e1",
      release: "mend-cli@1.2.3",
      // Trace and span IDs pass untouched: redactDetail would shorten 32 hex characters.
      contexts: { trace: { trace_id: "a".repeat(32), span_id: "b".repeat(16) } },
      exception: {
        values: [
          {
            type: "Error",
            value: "boom",
            mechanism: { type: "generic", handled: true },
            stacktrace: { frames: [{ filename: "app:///dist/main.js", lineno: 3 }] },
          },
        ],
      },
    });
  });
});
