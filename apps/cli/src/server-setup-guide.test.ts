import { describe, expect, it } from "vitest";

import {
  flagsFor,
  type GuideObservations,
  type GuideOutcome,
  runGuide,
  sameSettings,
  setupCommandOf,
  type SetupSettings,
  tailscaleFactsOf,
} from "./server-setup-guide.ts";
import { resolveSetupSettings, type ServerConfig } from "./server-setup.ts";

/** The owner's box: public behind the edge, SSH beside it, a Serve origin, many organizations. */
const BOX: ServerConfig = {
  schemaVersion: 1,
  assetContract: "mend-docker-v2",
  serverVersion: "0.36.0",
  dockerContext: "default",
  dockerEndpoint: "unix:///var/run/docker.sock",
  dockerSocket: "/var/run/docker.sock",
  dockerSocketSource: "detected",
  bind: "127.0.0.1",
  sshBind: "0.0.0.0",
  appUrl: "https://alpha.mend.run",
  allowedOrigins: ["https://mend-box.tailc79e49.ts.net:8443"],
  appPort: 3105,
  sshPort: 2222,
  bucket: "garage",
  edgeHost: "alpha.mend.run",
  exposure: "public",
  tenancy: "multi",
  declared: ["workspace-ssh", "core-private"],
  mirrors: { npm: { maxSize: "10g" }, docker: { maxSize: "20g" } },
};

const TAILSCALE_STATUS = JSON.stringify({
  BackendState: "Running",
  Self: {
    DNSName: "mend-box.tailc79e49.ts.net.",
    TailscaleIPs: ["100.94.101.28", "fd7a:115c:a1e0::1"],
  },
});

const SERVE_STATUS = JSON.stringify({
  TCP: { "8443": { HTTPS: true } },
  Web: {
    "mend-box.tailc79e49.ts.net:8443": {
      Handlers: { "/": { Proxy: "http://127.0.0.1:3105" } },
    },
  },
  AllowFunnel: {},
});

const observe = (overrides: Partial<GuideObservations> = {}): GuideObservations => ({
  tailscale: async () => tailscaleFactsOf(TAILSCALE_STATUS, SERVE_STATUS),
  lookupHost: async () => ["203.0.113.7"],
  localAddresses: () => ["203.0.113.7", "192.168.1.20", "100.94.101.28"],
  portTaken: async () => false,
  ...overrides,
});

/** A conversation with scripted answers; every prompt and line is kept, answers echoed. */
const converse = async (
  answers: ReadonlyArray<string>,
  saved: ServerConfig | null,
  observations: GuideObservations = observe(),
): Promise<{ readonly outcome: GuideOutcome; readonly transcript: string }> => {
  const queue = [...answers];
  const lines: Array<string> = [];
  const outcome = await runGuide(
    {
      write: (line) => lines.push(line),
      ask: async (prompt) => {
        const given = queue.shift();
        lines.push(`${prompt}${given ?? "^D"}`);
        return given ?? null;
      },
    },
    {
      saved: saved === null ? null : resolveSetupSettings(saved, []),
      defaults: resolveSetupSettings(null, []),
      observe: observations,
      resolve: (flags) => resolveSetupSettings(saved, flags),
    },
  );
  expect(queue).toEqual([]);
  return { outcome, transcript: lines.join("\n") };
};

const flagsOf = (outcome: GuideOutcome): ReadonlyArray<string> => {
  if (outcome._tag !== "apply") throw new Error(`expected apply, got ${outcome._tag}`);
  return outcome.flags;
};

describe("the guided server setup", () => {
  it("asks a fresh install its questions and derives the flags: this machine only", async () => {
    // reach: enter (this machine) · T3: enter (no) · mirrors: keep · tenancy: one · apply
    const { outcome, transcript } = await converse(
      ["", "", "", "", ""],
      null,
      observe({ tailscale: async () => null }),
    );
    expect(flagsOf(outcome)).toEqual(["--exposure", "loopback"]);
    expect(transcript).toContain("How will people reach this Mend?");
    expect(transcript).toContain("Same as: mend server setup --exposure loopback");
    expect(transcript).toContain("Setup will install:");
    expect(transcript).not.toMatch(/bind/i);
  });

  it("offers the tailnet: the MagicDNS name becomes the URL, the tailnet address the listener", async () => {
    // reach: network · which network: 1 (Tailscale) · URL: enter · Serve origin: yes · T3: yes ·
    // mirrors: keep · tenancy: several · apply
    const { outcome, transcript } = await converse(["2", "1", "", "y", "y", "", "2", "y"], null);
    const flags = flagsOf(outcome);
    expect(flags).toEqual([
      "--bind",
      "100.94.101.28",
      "--url",
      "http://mend-box.tailc79e49.ts.net:3105",
      "--origin",
      "https://mend-box.tailc79e49.ts.net:8443",
      "--exposure",
      "private",
      "--tenancy",
      "multi",
      "--t3-gateway",
    ]);
    expect(transcript).toContain(
      "Observed: Tailscale is up; this machine is mend-box.tailc79e49.ts.net at 100.94.101.28 on your tailnet.",
    );
    expect(transcript).toContain(
      "Observed: Tailscale Serve forwards https://mend-box.tailc79e49.ts.net:8443 to Mend's port here.",
    );
    expect(resolveSetupSettings(null, flags)).toMatchObject({
      bind: "100.94.101.28",
      appUrl: "http://mend-box.tailc79e49.ts.net:3105",
      exposure: "private",
      t3GatewayPort: 3120,
    });
  });

  it("says when tailscale did not answer, and still offers this machine's addresses", async () => {
    const { outcome, transcript } = await converse(
      ["2", "1", "", "", "", "", ""],
      null,
      observe({ tailscale: async () => null, localAddresses: () => ["192.168.1.20"] }),
    );
    expect(transcript).toContain("Observed: tailscale did not answer on this machine.");
    expect(flagsOf(outcome)).toEqual([
      "--bind",
      "192.168.1.20",
      "--url",
      "http://192.168.1.20:3105",
      "--exposure",
      "private",
    ]);
  });

  it("refuses a public edge on a fresh install with the order that works, and installs on this machine", async () => {
    const { outcome, transcript } = await converse(
      ["3", "", "", "", ""],
      null,
      observe({ tailscale: async () => null }),
    );
    expect(transcript).toContain("A fresh install starts on this machine first.");
    expect(flagsOf(outcome)).toEqual(["--exposure", "loopback"]);
  });

  it("re-running shows the current setup and changes one thing, keeping every declaration", async () => {
    // change something · the T3 Code gateway (3rd: reach, ssh, t3) · yes · nothing else · apply
    const { outcome, transcript } = await converse(["2", "3", "y", "", ""], BOX);
    expect(transcript).toContain(
      "Currently: public HTTPS at alpha.mend.run, VS Code SSH from other machines on, T3 gateway off.",
    );
    expect(transcript).toContain("  T3 Code gateway: off → on, at 127.0.0.1:3120");
    const flags = flagsOf(outcome);
    expect(flags).toEqual(["--t3-gateway"]);
    expect(setupCommandOf(flags)).toBe("mend server setup --t3-gateway");
    // The flags alone, against the saved config, keep the rest: the edge, SSH, the declarations.
    const after = resolveSetupSettings(BOX, flags);
    expect(after).toMatchObject({
      edgeHost: "alpha.mend.run",
      sshBind: "0.0.0.0",
      exposure: "public",
      tenancy: "multi",
      allowedOrigins: ["https://mend-box.tailc79e49.ts.net:8443"],
      t3GatewayPort: 3120,
    });
    expect(after.declared.toSorted()).toEqual(["core-private", "workspace-ssh"]);
  });

  it("keeping it as it is changes nothing and says the command a script runs", async () => {
    const { outcome, transcript } = await converse(["", ""], BOX);
    expect(flagsOf(outcome)).toEqual([]);
    expect(transcript).toContain(
      "Nothing changes: setup checks this install and starts it as it is.",
    );
    expect(transcript).toContain("Same as: mend server setup --yes");
  });

  it("moves workspace SSH to the tailnet and asks for the statement a public start needs", async () => {
    // change · VS Code Remote-SSH (2) · over Tailscale (2) · I checked (1) · nothing else · apply
    const { outcome, transcript } = await converse(["2", "2", "2", "1", "", ""], BOX);
    expect(transcript).toContain("Mend cannot see who reaches 100.94.101.28:2222 from outside");
    expect(flagsOf(outcome)).toEqual(["--ssh-bind", "100.94.101.28"]);
  });

  it("'not yet' keeps SSH on this machine and takes back a statement it no longer needs", async () => {
    // change · VS Code Remote-SSH · from any network · not yet · nothing else · apply
    const { outcome } = await converse(["2", "2", "3", "2", "", ""], BOX);
    expect(flagsOf(outcome)).toEqual(["--ssh-bind", "127.0.0.1", "--undeclare", "workspace-ssh"]);
  });

  it("from public back to this machine: the edge goes, and the SSH statement with it", async () => {
    // change · reach (1) · just this machine (1) · nothing else · apply
    const { outcome, transcript } = await converse(["2", "1", "1", "", ""], BOX);
    const flags = flagsOf(outcome);
    expect(flags).toEqual([
      "--no-edge",
      "--url",
      "http://localhost:3105",
      "--ssh-bind",
      "127.0.0.1",
      "--exposure",
      "loopback",
      "--undeclare",
      "workspace-ssh",
    ]);
    expect(transcript).toContain("  you declared: workspace-ssh, core-private → core-private");
    expect(resolveSetupSettings(BOX, flags).declared).toEqual(["core-private"]);
  });

  it("checks the domain's DNS and the edge's ports when public HTTPS is chosen", async () => {
    const { sshBind: _ssh, edgeHost: _edge, tenancy: _tenancy, declared: _declared, ...rest } = BOX;
    const lan: ServerConfig = {
      ...rest,
      appUrl: "http://192.168.1.20:3105",
      bind: "192.168.1.20",
      allowedOrigins: [],
      exposure: "private",
    };
    // change · reach · public · domain · SSH: from any network (3) · I checked · nothing else · apply
    const { outcome, transcript } = await converse(
      ["2", "1", "3", "mend.example.com", "3", "1", "", ""],
      lan,
      observe({
        tailscale: async () => tailscaleFactsOf(TAILSCALE_STATUS, ""),
        lookupHost: async () => ["198.51.100.9"],
        portTaken: async (port) => port === 80,
      }),
    );
    expect(transcript).toContain(
      "Observed: mend.example.com resolves to 198.51.100.9; this machine's own addresses are 203.0.113.7, 192.168.1.20, 100.94.101.28.",
    );
    expect(transcript).toContain(
      "Observed: something on this machine already listens on 80; the edge needs it.",
    );
    expect(flagsOf(outcome)).toEqual([
      "--edge",
      "mend.example.com",
      "--bind",
      "127.0.0.1",
      "--ssh-bind",
      "0.0.0.0",
      "--exposure",
      "public",
      "--declare",
      "workspace-ssh",
    ]);
  });

  it("re-asks an answer it cannot use, and stops with nothing changed on Ctrl+D", async () => {
    const { outcome, transcript } = await converse(["7", "x"], null);
    expect(transcript).toContain('"7" is not one of the choices.');
    expect(outcome).toEqual({ _tag: "stopped" });
  });

  it("answering no to apply changes nothing", async () => {
    const { outcome } = await converse(["", "n"], BOX);
    expect(outcome).toEqual({ _tag: "stopped" });
  });

  it("changes the mirrors with their caps", async () => {
    // change · mirrors (5th: reach, ssh, t3, declared, mirrors) · npm off · docker on · 40g · done · apply
    const { outcome } = await converse(["2", "5", "n", "y", "40g", "", ""], BOX);
    expect(flagsOf(outcome)).toEqual(["--no-npm-mirror", "--docker-mirror-max-size", "40g"]);
  });

  it("removes an extra origin with --origin none", async () => {
    // change · origins (7th) · remove one · the first · keep these · nothing else · apply
    const { outcome } = await converse(["2", "7", "3", "1", "1", "", ""], BOX);
    expect(flagsOf(outcome)).toEqual(["--origin", "none"]);
  });
});

const settings = (config: ServerConfig): SetupSettings => resolveSetupSettings(config, []);

describe("the guide's flags round-trip", () => {
  const variants: ReadonlyArray<readonly [string, ServerConfig, SetupSettings]> = [
    ["the gateway on a port of its own", BOX, { ...settings(BOX), t3GatewayPort: 4120 }],
    [
      "one declaration taken back, one added",
      BOX,
      { ...settings(BOX), declared: ["workspace-ssh", "edge-tls"] },
    ],
    [
      "every declaration taken back, SSH on loopback",
      BOX,
      {
        ...settings(BOX),
        sshBind: undefined,
        declared: [],
      },
    ],
    [
      "mirrors back on after both were off",
      { ...BOX, mirrors: { npm: null, docker: null } },
      { ...settings(BOX), mirrors: { npm: { maxSize: "10g" }, docker: { maxSize: "30g" } } },
    ],
    [
      "a Docker Hub login dropped with its mirror",
      {
        ...BOX,
        mirrors: {
          npm: { maxSize: "10g" },
          docker: { maxSize: "20g", upstreamUser: "mendbot", upstreamPublicOnly: true },
        },
      },
      { ...settings(BOX), mirrors: { npm: { maxSize: "10g" }, docker: null } },
    ],
  ];
  for (const [name, saved, target] of variants) {
    it(name, () => {
      const flags = flagsFor(settings(saved), target);
      expect(sameSettings(resolveSetupSettings(saved, flags), target)).toBe(true);
    });
  }

  it("the summary's command, parsed back, is the same settings", async () => {
    const { outcome, transcript } = await converse(["2", "1", "", "y", "y", "", "2", "y"], null);
    const command = /Same as: (.*)/.exec(transcript)?.[1] ?? "";
    const flags = command.split(" ").slice(3);
    expect(flags).toEqual(flagsOf(outcome));
    expect(
      sameSettings(resolveSetupSettings(null, flags), resolveSetupSettings(null, flagsOf(outcome))),
    ).toBe(true);
  });
});

describe("tailscale's own words", () => {
  it("reads the MagicDNS name, the tailnet address and what Serve and Funnel forward", () => {
    const facts = tailscaleFactsOf(
      TAILSCALE_STATUS,
      JSON.stringify({
        Web: {
          "mend-box.tailc79e49.ts.net:443": {
            Handlers: { "/": { Proxy: "http://localhost:3105" } },
          },
          "mend-box.tailc79e49.ts.net:8443": { Handlers: { "/": { Proxy: "http://10.0.0.5:80" } } },
        },
        AllowFunnel: { "mend-box.tailc79e49.ts.net:443": true },
      }),
    );
    expect(facts).toEqual({
      running: true,
      dnsName: "mend-box.tailc79e49.ts.net",
      ipv4: "100.94.101.28",
      serve: [
        { origin: "https://mend-box.tailc79e49.ts.net", loopbackPort: 3105, funnel: true },
        { origin: "https://mend-box.tailc79e49.ts.net:8443", loopbackPort: null, funnel: false },
      ],
    });
  });

  it("is nothing when the output is not Tailscale's", () => {
    expect(tailscaleFactsOf("", "")).toBeNull();
    expect(tailscaleFactsOf("not json", "")).toBeNull();
  });
});
