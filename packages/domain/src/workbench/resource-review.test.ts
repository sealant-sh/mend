import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { resourceReviewRows } from "./resource-review.ts";
import { ResourceDefinitionInput } from "./resource.ts";

const decode = Schema.decodeUnknownSync(ResourceDefinitionInput);
const spec = (fields: Record<string, unknown>) =>
  decode({
    name: "mail",
    scope: "project",
    preset: null,
    image: "axllent/mailpit:v1.21",
    command: null,
    ports: [{ name: "smtp", port: 1025, protocol: "tcp" }],
    env: {},
    volumes: [],
    ready: { kind: "tcp" },
    exports: {},
    ...fields,
  });
const rows = (fields: Record<string, unknown>) =>
  resourceReviewRows(spec(fields), "a".repeat(64)).map((row) => `${row.label} ${row.value}`);

describe("an approval's review", () => {
  it("keeps every argument and env entry apart, so two different specs never read alike", () => {
    const joined = rows({ command: ["sh", "-c", "echo hello; exit 1"] });
    const split = rows({ command: ["sh", "-c", "echo", "hello; exit 1"] });
    expect(joined).toContain('command ["sh","-c","echo hello; exit 1"]');
    expect(split).toContain('command ["sh","-c","echo","hello; exit 1"]');

    const one = rows({ env: { NOTE: "hello, REQUIRE_AUTH=true" } });
    const two = rows({ env: { NOTE: "hello", REQUIRE_AUTH: "true" } });
    expect(one.filter((row) => row.startsWith("env "))).toEqual([
      'env NOTE "hello, REQUIRE_AUTH=true"',
    ]);
    expect(two.filter((row) => row.startsWith("env "))).toEqual([
      'env NOTE "hello"',
      'env REQUIRE_AUTH "true"',
    ]);
  });

  it("quotes a secret's name and a ready command, and ends with the definition digest", () => {
    expect(
      rows({
        env: { MP_UI_AUTH: { secret: "MAILPIT AUTH" } },
        volumes: [{ name: "data", mountPath: "/var/lib/mail box" }],
        ready: { kind: "command", argv: ["nc", "-z", "localhost", "1025"] },
        exports: { URL: "smtp://{host}:{port.smtp}" },
      }),
    ).toEqual([
      "image axllent/mailpit:v1.21",
      "scope project",
      "port smtp 1025/tcp",
      'volume data "/var/lib/mail box"',
      'env MP_UI_AUTH secret "MAILPIT AUTH"',
      "limits 1 CPU · 1024 MiB memory · 10 GiB disk",
      'ready ["nc","-z","localhost","1025"]',
      'export URL "smtp://{host}:{port.smtp}"',
      `definition digest sha256:${"a".repeat(64)}`,
    ]);
  });
});
