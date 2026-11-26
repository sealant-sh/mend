import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { serverCommand } from "./server-setup.ts";
import {
  parseTelemetryField,
  parseTelemetryValue,
  renderTelemetryOverlay,
  resolveTelemetry,
  TELEMETRY_FIELDS,
  telemetryLine,
} from "./server-telemetry.ts";

const { cleanups, fixture } = lifecycleTestFixtures();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const OVERLAY = "compose.telemetry.yaml";
const MEND_DSN = "https://0123456789abcdef0123456789abcdef@sentry.example.test/3";
const SEALANT_DSN = "https://fedcba9876543210fedcba9876543210@sentry.example.test/2";
const BROWSER_DSN = "https://00112233445566778899aabbccddeeff@sentry.example.test/4";
const SEALANTD_DSN = "https://ffeeddccbbaa99887766554433221100@sentry.example.test/10";
const OFF_LINE = "telemetry · off: this server reports its errors and traces to nobody";
const SET_LINE =
  "telemetry · Mend's servers report to sentry.example.test project 3, sealant's to sentry.example.test project 2, sealantd's to sentry.example.test project 10, the browser nothing, environment box, traces sampled at 0.5";

const field = (flag: string) => {
  const found = TELEMETRY_FIELDS.find((each) => each.flag === flag);
  if (found === undefined) throw new Error(`no field for ${flag}`);
  return found;
};

describe("where a server's errors and traces go", () => {
  it("takes a Sentry DSN, an environment name and a sample rate from 0 to 1", () => {
    for (const value of [MEND_DSN, "http://key@localhost:9000/12", "default"])
      expect(parseTelemetryValue(field("--sentry-dsn"), value)).toBe(value);
    for (const value of [
      "",
      "sentry.example.test/3",
      "https://sentry.example.test/3",
      "https://key@sentry.example.test/",
      "https://key@sentry.example.test/three",
      `${MEND_DSN}"`,
      `${MEND_DSN} `,
    ])
      expect(parseTelemetryValue(field("--sentry-dsn"), value)).toBeNull();
    for (const value of ["box", "check-vm.3", "slnt_1355"])
      expect(parseTelemetryValue(field("--sentry-environment"), value)).toBe(value);
    for (const value of ["", "has space", '"quoted"', "-dash", "x".repeat(65)])
      expect(parseTelemetryValue(field("--sentry-environment"), value)).toBeNull();
    for (const value of ["0", "1", "0.25", "1.0", ".5"])
      expect(parseTelemetryValue(field("--sentry-traces-sample-rate"), value)).toBe(value);
    for (const value of ["", "2", "-0.1", "1.5", "abc", "0.1234567"])
      expect(parseTelemetryValue(field("--sentry-traces-sample-rate"), value)).toBeNull();
  });

  it("keeps a saved value through silence, and drops it with default", () => {
    const saved = { dsn: MEND_DSN, environment: "box" };
    expect(resolveTelemetry(saved, {})).toEqual(saved);
    expect(resolveTelemetry(saved, { environment: "default", sealantDsn: SEALANT_DSN })).toEqual({
      dsn: MEND_DSN,
      sealantDsn: SEALANT_DSN,
    });
    expect(resolveTelemetry(saved, { dsn: "default", environment: "default" })).toBeUndefined();
    expect(resolveTelemetry(undefined, {})).toBeUndefined();
  });

  it("reads back only what a setup writes", () => {
    expect(parseTelemetryField({ dsn: MEND_DSN })).toEqual({ dsn: MEND_DSN });
    for (const raw of [
      {},
      null,
      [],
      MEND_DSN,
      { dsn: "default" },
      { dsn: 3 },
      { dsn: "sentry.example.test/3" },
      { dsn: MEND_DSN, other: "x" },
      { tracesSampleRate: "2" },
    ])
      expect(parseTelemetryField(raw)).toBeNull();
  });

  it("renders an overlay only for the values the install sets, and says where they go", () => {
    expect(renderTelemetryOverlay(undefined)).toBeUndefined();
    const overlay = renderTelemetryOverlay({ dsn: MEND_DSN, browserDsn: BROWSER_DSN }) ?? "";
    expect(overlay).toContain(
      `  mend:\n    environment:\n      MEND_SENTRY_DSN: "${MEND_DSN}"\n      SENTRY_BROWSER_DSN: "${BROWSER_DSN}"\n`,
    );
    expect(overlay).not.toContain("SEALANT_SENTRY_DSN");
    expect(overlay).not.toContain("SEALANTD_SENTRY_DSN");
    expect(telemetryLine(undefined)).toBe(OFF_LINE);
    // The key in a DSN is not a secret, and still never printed.
    expect(telemetryLine({ dsn: MEND_DSN })).not.toContain("0123456789abcdef");
  });
});

describe("telemetry on the Docker install", { timeout: 120_000 }, () => {
  it("is off on a new install, which writes nothing for it", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    const files = f.files();
    expect(files[OVERLAY]).toBeUndefined();
    expect(JSON.parse(files["server.json"] ?? "{}")).not.toHaveProperty("telemetry");
    expect(files["server.env"]).not.toContain("SENTRY");
    f.lines.length = 0;
    expect(await serverCommand(["status"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.lines).toContain(OFF_LINE);
  });

  it("reaches the mend container from the config, and survives a rerun and an upgrade", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    const envBefore = f.files()["server.env"];
    f.lines.length = 0;
    expect(
      await serverCommand(
        [
          "setup",
          "--offline",
          "--sentry-dsn",
          MEND_DSN,
          "--sealant-sentry-dsn",
          SEALANT_DSN,
          "--sealantd-sentry-dsn",
          SEALANTD_DSN,
          "--sentry-environment",
          "box",
          "--sentry-traces-sample-rate",
          "0.5",
        ],
        f.runtime,
      ),
    ).toEqual({ _tag: "ok" });
    expect(f.lines).toContain(`${SET_LINE}. It applies once Mend restarts.`);
    const files = f.files();
    expect(JSON.parse(files["server.json"] ?? "{}").telemetry).toEqual({
      dsn: MEND_DSN,
      sealantDsn: SEALANT_DSN,
      sealantdDsn: SEALANTD_DSN,
      environment: "box",
      tracesSampleRate: "0.5",
    });
    expect(files[OVERLAY]).toContain(
      `      MEND_SENTRY_DSN: "${MEND_DSN}"\n      SEALANT_SENTRY_DSN: "${SEALANT_DSN}"\n      SEALANTD_SENTRY_DSN: "${SEALANTD_DSN}"\n      SENTRY_ENVIRONMENT: "box"\n      SENTRY_TRACES_SAMPLE_RATE: "0.5"\n`,
    );
    // server.env is untouched: a CLI from before the setting still reads the install.
    expect(files["server.env"]).toBe(envBefore);
    expect(f.state().upFiles).toContain(OVERLAY);

    f.lines.length = 0;
    expect(await serverCommand(["status"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.lines).toContain(SET_LINE);

    // A rerun that names none of them keeps them, and says nothing about them.
    f.lines.length = 0;
    expect(await serverCommand(["setup", "--offline", "--yes"], f.runtime)).toEqual({
      _tag: "ok",
    });
    expect(f.lines.some((line) => line.startsWith("telemetry"))).toBe(false);
    expect(f.files()[OVERLAY]).toBe(files[OVERLAY]);

    expect(await f.upgrade()).toEqual({ _tag: "ok" });
    expect(f.files()[OVERLAY]).toBe(files[OVERLAY]);
    expect(f.state().upFiles).toContain(OVERLAY);

    // Off again, one value at a time.
    expect(
      await serverCommand(
        [
          "setup",
          "--offline",
          "--sentry-dsn",
          "default",
          "--sealant-sentry-dsn",
          "default",
          "--sealantd-sentry-dsn",
          "default",
          "--sentry-environment",
          "default",
          "--sentry-traces-sample-rate",
          "default",
        ],
        f.runtime,
      ),
    ).toEqual({ _tag: "ok" });
    expect(f.files()[OVERLAY]).toBeUndefined();
    expect(JSON.parse(f.files()["server.json"] ?? "{}")).not.toHaveProperty("telemetry");
    expect(f.state().upFiles).not.toContain(OVERLAY);
  });

  it("refuses a value that is not what its flag takes", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    for (const [flag, value] of [
      ["--sentry-dsn", "sentry.example.test/3"],
      ["--sealant-sentry-dsn", "https://sentry.example.test/2"],
      ["--sealantd-sentry-dsn", "https://key@sentry.example.test/ten"],
      ["--sentry-browser-dsn", `${BROWSER_DSN}"`],
      ["--sentry-environment", "has space"],
      ["--sentry-traces-sample-rate", "2"],
    ] as const) {
      const result = await serverCommand(["setup", "--offline", flag, value], f.runtime);
      expect(result._tag).toBe("error");
      expect(result._tag === "error" ? result.message : "").toContain(`${flag} must be `);
      if (flag.endsWith("-dsn"))
        expect(result._tag === "error" ? result.message : "").toContain(
          "the project's public key and its id",
        );
    }
    expect(f.files()[OVERLAY]).toBeUndefined();
  });

  it("refuses a config or an overlay that is not what a setup writes", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    expect(
      await serverCommand(["setup", "--offline", "--sentry-dsn", MEND_DSN], f.runtime),
    ).toEqual({ _tag: "ok" });
    const overlay = path.join(f.active(), OVERLAY);
    const written = fs.readFileSync(overlay, "utf8");
    fs.writeFileSync(overlay, written.replace(MEND_DSN, SEALANT_DSN));
    const tampered = await serverCommand(["status"], f.runtime);
    expect(tampered._tag === "error" ? tampered.message : "").toContain(
      `${OVERLAY} does not match the saved telemetry settings`,
    );
    fs.writeFileSync(overlay, written);
    const config = path.join(f.active(), "server.json");
    const saved = JSON.parse(fs.readFileSync(config, "utf8"));
    fs.writeFileSync(
      config,
      `${JSON.stringify({ ...saved, telemetry: { dsn: "nowhere" } }, null, 2)}\n`,
    );
    const corrupt = await serverCommand(["status"], f.runtime);
    expect(corrupt._tag === "error" ? corrupt.message : "").toContain(
      "Server config is corrupt: telemetry must hold Sentry DSNs",
    );
  });
});
