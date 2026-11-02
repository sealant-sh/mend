import { describe, expect, it } from "vitest";

import { resourceTableToml, type ResourceTableFields } from "./resource-toml.ts";
import {
  presetDefinition,
  PresetVersion,
  RESOURCE_LIMIT_DEFAULTS,
  ResourceName,
} from "./resource.ts";

const mail: ResourceTableFields = {
  name: ResourceName.make("mail"),
  preset: null,
  image: "axllent/mailpit:v1.21",
  command: null,
  ports: [
    { name: "smtp", port: 1025, protocol: "tcp" },
    { name: "http", port: 8025, protocol: "tcp" },
  ],
  volumes: [{ name: "data", mountPath: "/data" }],
  env: { MP_DATABASE: "/data/mailpit.db" },
  exports: { URL: "smtp://{host}:{port.smtp}" },
  ready: { kind: "tcp" },
  limits: RESOURCE_LIMIT_DEFAULTS,
};

describe("resourceTableToml", () => {
  it("renders the complete compact Postgres example", () => {
    const input = {
      name: ResourceName.make("db"),
      preset: "postgres" as const,
      version: PresetVersion.make("17"),
    };
    expect(resourceTableToml(presetDefinition(input))).toBe(
      '[resource.db]\npreset = "postgres"\nimage = "postgres:17"\n',
    );
  });
  it("renders the complete Mailpit example", () => {
    expect(resourceTableToml(mail)).toBe(
      '[resource.mail]\nimage = "axllent/mailpit:v1.21"\nports = { smtp = 1025, http = 8025 }\nvolumes = { data = "/data" }\nenv = { MP_DATABASE = "/data/mailpit.db" }\nexports = { URL = "smtp://{host}:{port.smtp}" }\n',
    );
  });
  it("quotes unsafe keys and escapes quotes and backslashes", () => {
    expect(resourceTableToml({ ...mail, env: { "a.b": 'a"b\\c', "": "empty key" } })).toContain(
      'env = { "a.b" = "a\\"b\\\\c", "" = "empty key" }',
    );
  });
});
