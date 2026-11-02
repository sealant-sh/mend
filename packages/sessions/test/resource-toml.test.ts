import {
  presetDefinition,
  PresetVersion,
  RESOURCE_LIMIT_DEFAULTS,
  ResourceName,
  type ResourceTableFields,
  resourceTableToml,
} from "@mend/domain/workbench";
import * as fc from "fast-check";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";

import { readResourceTables } from "../src/resource-tables.ts";

const generic: ResourceTableFields = {
  name: ResourceName.make("dns"),
  preset: null,
  image: "coredns/coredns:1.12",
  command: ["/coredns", "-conf", "/etc/Corefile"],
  ports: [
    { name: "dns", port: 53, protocol: "udp" },
    { name: "health", port: 8080, protocol: "tcp" },
  ],
  env: { VALUE: 'quoted " and backslash \\ and Unicode λ', TOKEN: { secret: "API_TOKEN" } },
  volumes: [{ name: "data", mountPath: "/data" }],
  exports: { URL: "http://{host}:{port.health}" },
  ready: { kind: "command", argv: ["/probe", 'a"b\\c', ""] },
  limits: { cpu: 0.5, memoryMiB: 512, diskGiB: 4 },
};
const presets = (["postgres", "redis", "mysql"] as const).flatMap((preset) =>
  ["17", "18"].map((version) =>
    presetDefinition({
      name: ResourceName.make("db"),
      preset,
      version: PresetVersion.make(version),
    }),
  ),
);
const definitions: ReadonlyArray<ResourceTableFields> = [
  ...presets,
  ...presets.map((def) => ({ ...def, volumes: [] })),
  ...presets.map((def) => ({
    ...def,
    ports: [{ name: "custom", port: 1234, protocol: "tcp" as const }],
    volumes: [{ name: "custom", mountPath: "/custom" }],
  })),
  generic,
  { ...generic, command: null, ready: { kind: "tcp" }, limits: RESOURCE_LIMIT_DEFAULTS },
  {
    ...generic,
    ports: [{ name: "dns", port: 53, protocol: "udp" }],
    exports: {},
    command: null,
    ready: { kind: "none" },
  },
];
const withoutScope = (def: ResourceTableFields): ResourceTableFields => {
  const { name, preset, image, command, ports, volumes, env, exports, ready, limits } = def;
  return { name, preset, image, command, ports, volumes, env, exports, ready, limits };
};
const roundTrip = (def: ResourceTableFields) => {
  const parsed = parseToml(resourceTableToml(def));
  const read = readResourceTables(parsed["resource"]);
  expect(read.refused).toEqual([]);
  expect(read.ignored).toEqual([]);
  expect(read.tables.map(withoutScope)).toEqual([withoutScope(def)]);
};

describe("resource table serialization", () => {
  it.each(definitions)("round-trips definition %#", roundTrip);
  it("round-trips arbitrary literal strings, commands, probes, ports and limits", () => {
    const text = fc
      .array(fc.constantFrom('"', "\\", "a", "λ", " ", "é", "'", "[", "]", "=", "."), {
        maxLength: 60,
      })
      .map((chars) => chars.join(""));
    fc.assert(
      fc.property(
        text,
        fc.integer({ min: 1, max: 65535 }),
        fc.integer({ min: 1, max: 4096 }),
        (value, port, memoryMiB) => {
          roundTrip({
            ...generic,
            command: ["/run", value],
            env: { VALUE: value, TOKEN: { secret: "API_TOKEN" } },
            ports: [
              { name: "dns", port, protocol: "udp" },
              { name: "health", port: 8080, protocol: "tcp" },
            ],
            ready: { kind: "command", argv: ["/probe", value] },
            limits: { cpu: 1, memoryMiB, diskGiB: 10 },
          });
        },
      ),
      { numRuns: 100 },
    );
  });
});
