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
    // reach: network · which network: 1 (Tailscale) · URL: enter · SSH: enter (over Tailscale) ·
    // Serve origin: yes · T3: yes · mirrors: keep · tenancy: several · apply
    const { outcome, transcript } = await converse(
      ["2", "1", "", "", "y", "y", "", "2", "y"],
      null,
    );
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
      "Observed: Tailscale is up; this machine is mend-box.tailc79e49.ts.net at 100.94.101.28 and fd7a:115c:a1e0::1 on your tailnet.",
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
      ["2", "1", "", "", "", "", "", ""],
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

  it("never offers a public address as a private network: a public-only VPS installs on this machine", async () => {
    const vps = observe({
      tailscale: async () => null,
      localAddresses: () => ["203.0.113.5", "2a01:4f8::1"],
    });
    // reach: network · (no network to choose) · T3 · mirrors · tenancy · apply
    const { outcome, transcript } = await converse(["2", "", "", "", ""], null, vps);
    expect(transcript).toContain(
      "Observed: 203.0.113.5 is a public address. Published there, Mend answers the internet, not a network you control who joins, so setup does not offer it here.",
    );
    expect(transcript).toContain("This machine has no address on a private network");
    expect(transcript).toContain("ssh -L 3105:127.0.0.1:3105 <this machine>");
    expect(transcript).toContain("or choose the public internet, with HTTPS");
    expect(transcript).toContain("Setup installs Mend on this machine now.");
    expect(transcript).not.toContain("Which network do people reach it on?");
    expect(transcript).not.toContain("0.0.0.0");
    expect(flagsOf(outcome)).toEqual(["--exposure", "loopback"]);
  });

  it("pre-selects the private address beside a public one, and does not offer every address", async () => {
    const mixed = observe({
      tailscale: async () => null,
      localAddresses: () => ["203.0.113.5", "10.0.0.4"],
    });
    // reach: network · which network: enter · URL: enter · SSH: enter · T3 · mirrors · tenancy ·
    // apply
    const { outcome, transcript } = await converse(["2", "", "", "", "", "", "", ""], null, mixed);
    expect(transcript).toContain("  1. on this network address, 10.0.0.4");
    expect(transcript).toContain("  1 [1]: ");
    expect(transcript).not.toContain("on this network address, 203.0.113.5");
    expect(transcript).not.toContain("on every address of this machine");
    // Every address for SSH is said as what it includes.
    expect(transcript).toContain(
      "SSH on 0.0.0.0:2222, every address, and that includes 203.0.113.5, which the internet reaches",
    );
    expect(flagsOf(outcome)).toEqual([
      "--bind",
      "10.0.0.4",
      "--url",
      "http://10.0.0.4:3105",
      "--exposure",
      "private",
    ]);
  });

  it("offers carrier-grade NAT space and the tailnet, and pre-selects the tailnet over a public address", async () => {
    const cgnat = observe({
      tailscale: async () => null,
      localAddresses: () => ["203.0.113.5", "100.70.1.2"],
    });
    const carrier = await converse(["2", "", "", "", "", "", "", ""], null, cgnat);
    expect(flagsOf(carrier.outcome)).toEqual([
      "--bind",
      "100.70.1.2",
      "--url",
      "http://100.70.1.2:3105",
      "--exposure",
      "private",
    ]);
    // The default observations hold a public address, a LAN address and the tailnet.
    const tailnet = await converse(["2", "", "", "", "n", "", "", "", ""], null);
    expect(tailnet.transcript).toContain("  1. over Tailscale, as mend-box.tailc79e49.ts.net");
    expect(tailnet.transcript).toContain("  2. on this network address, 192.168.1.20");
    expect(tailnet.transcript).not.toContain("on this network address, 203.0.113.7");
    expect(flagsOf(tailnet.outcome)).toEqual([
      "--bind",
      "100.94.101.28",
      "--url",
      "http://mend-box.tailc79e49.ts.net:3105",
      "--exposure",
      "private",
    ]);
  });

  it("re-run on a public address: no private network to move to, so how it is reached stays as it is", async () => {
    const { tenancy: _t, declared: _d, edgeHost: _e, sshBind: _s, ...rest } = BOX;
    const exposed: ServerConfig = {
      ...rest,
      bind: "203.0.113.5",
      appUrl: "http://203.0.113.5:3105",
      allowedOrigins: [],
      exposure: "private",
    };
    // change · reach · network · nothing else · apply
    const { outcome, transcript } = await converse(
      ["2", "1", "2", "", ""],
      exposed,
      observe({ tailscale: async () => null, localAddresses: () => ["203.0.113.5"] }),
    );
    expect(transcript).not.toContain("where it listens now, 203.0.113.5");
    expect(transcript).toContain("How Mend is reached stays as it is.");
    expect(flagsOf(outcome)).toEqual([]);
  });

  it("a Funnel route is public: No by default under this machine, and not offered on a fresh install", async () => {
    const funnel = observe({
      tailscale: async () =>
        tailscaleFactsOf(
          TAILSCALE_STATUS,
          JSON.stringify({
            Web: {
              "mend-box.tailc79e49.ts.net:443": {
                Handlers: { "/": { Proxy: "http://127.0.0.1:3105" } },
              },
            },
            AllowFunnel: { "mend-box.tailc79e49.ts.net:443": true },
          }),
        ),
    });
    const { tenancy: _t, declared: _d, edgeHost: _e, sshBind: _s, ...rest } = BOX;
    const machine: ServerConfig = {
      ...rest,
      bind: "127.0.0.1",
      appUrl: "http://localhost:3105",
      allowedOrigins: [],
      exposure: "loopback",
    };
    // every question · reach: enter (this machine) · Funnel origin: enter · T3 · mirrors ·
    // tenancy · apply
    const rerun = await converse(["3", "", "", "", "", "", ""], machine, funnel);
    expect(rerun.transcript).toContain(
      "and Tailscale's settings have Funnel on for it: it is public, reached from the internet as well as your tailnet.",
    );
    expect(rerun.transcript).toContain("while the exposure is declared loopback");
    expect(rerun.transcript).toContain(
      "Allow https://mend-box.tailc79e49.ts.net, a public origin, as a browser origin? [y/N] ",
    );
    expect(flagsOf(rerun.outcome)).toEqual([]);

    // Fresh: reach: enter · T3 · mirrors · tenancy · apply. No question about the Funnel origin.
    const fresh = await converse(["", "", "", "", ""], null, funnel);
    expect(fresh.transcript).toContain("Setup does not add a public origin to a fresh install");
    expect(fresh.transcript).not.toContain("as a browser origin?");
    expect(flagsOf(fresh.outcome)).toEqual(["--exposure", "loopback"]);
  });

  it("moving the web on a rerun keeps SSH where it was published by default (review B-N1)", async () => {
    const { tenancy: _t, declared: _d, edgeHost: _e, sshBind: _s, ...rest } = BOX;
    const tailnet: ServerConfig = {
      ...rest,
      bind: "100.94.101.28",
      appUrl: "http://mend-box.tailc79e49.ts.net:3105",
      allowedOrigins: [],
      exposure: "private",
    };
    // change · reach · network · every address (3) · a URL · SSH: enter · Serve origin: no ·
    // nothing else · apply
    const { outcome, transcript } = await converse(
      ["2", "1", "2", "3", "http://mend.lan:3105", "", "n", "", ""],
      tailnet,
      observe({ localAddresses: () => ["192.168.1.20", "100.94.101.28"] }),
    );
    expect(transcript).toContain("  1-3 [2]: ");
    expect(flagsOf(outcome)).toEqual([
      "--bind",
      "0.0.0.0",
      "--url",
      "http://mend.lan:3105",
      "--ssh-bind",
      "100.94.101.28",
    ]);
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

  it("a domain that does not resolve here: Apply defaults to no, and says why", async () => {
    const { sshBind: _ssh, edgeHost: _edge, tenancy: _tenancy, declared: _declared, ...rest } = BOX;
    const lan: ServerConfig = {
      ...rest,
      appUrl: "http://192.168.1.20:3105",
      bind: "192.168.1.20",
      allowedOrigins: [],
      exposure: "private",
    };
    // change · reach · public · domain · SSH: from any network (3) · I checked · nothing else ·
    // Enter at Apply
    const unresolved = observe({
      tailscale: async () => tailscaleFactsOf(TAILSCALE_STATUS, ""),
      lookupHost: async () => null,
    });
    const entered = await converse(
      ["2", "1", "3", "mend.example.com", "3", "1", "", ""],
      lan,
      unresolved,
    );
    expect(entered.transcript).toContain(
      "Observed: mend.example.com does not resolve from this machine.",
    );
    expect(entered.transcript).toContain(
      "mend.example.com did not resolve from this machine, so the edge cannot get a certificate yet: Enter changes nothing. Point its DNS here first, or answer y to apply anyway.\nApply? [y/N] ",
    );
    expect(entered.outcome).toEqual({ _tag: "stopped" });
    const forced = await converse(
      ["2", "1", "3", "mend.example.com", "3", "1", "", "y"],
      lan,
      unresolved,
    );
    expect(flagsOf(forced.outcome)).toContain("--edge");
  });

  it("changing a private install's URL keeps SSH where it was published (review 664-1)", async () => {
    const { tenancy: _t, declared: _d, edgeHost: _e, ...rest } = BOX;
    const lan: ServerConfig = {
      ...rest,
      bind: "192.168.1.20",
      sshBind: "127.0.0.1",
      appUrl: "http://192.168.1.20:3105",
      allowedOrigins: [],
      exposure: "private",
    };
    const quiet = observe({ tailscale: async () => null, localAddresses: () => ["192.168.1.20"] });
    // change · reach · network · the same address · a new URL · SSH: enter keeps loopback ·
    // nothing else · apply
    const renamed = await converse(
      ["2", "1", "2", "", "http://mend.lan:3105", "", "", ""],
      lan,
      quiet,
    );
    expect(flagsOf(renamed.outcome)).toEqual(["--url", "http://mend.lan:3105"]);
    // The old URL accepted as it is: nothing changes at all.
    const same = await converse(["2", "1", "2", "", "", "", "", ""], lan, quiet);
    expect(flagsOf(same.outcome)).toEqual([]);
  });

  it("an extra origin that becomes the URL is folded away, back to this machine (review 664-2)", async () => {
    const { tenancy: _t, declared: _d, edgeHost: _e, sshBind: _s, ...rest } = BOX;
    const lan: ServerConfig = {
      ...rest,
      bind: "0.0.0.0",
      appUrl: "http://mend-host:3105",
      allowedOrigins: ["http://localhost:3105"],
      exposure: "private",
    };
    const quiet = observe({ tailscale: async () => null });
    // change · reach · just this machine · nothing else · apply
    const fromLan = await converse(["2", "1", "1", "", ""], lan, quiet);
    expect(flagsOf(fromLan.outcome)).toEqual([
      "--bind",
      "127.0.0.1",
      "--url",
      "http://localhost:3105",
      "--origin",
      "none",
      "--exposure",
      "loopback",
    ]);
    // The same from a public edge install that kept the localhost origin.
    const fromEdge = await converse(["2", "1", "1", "", ""], {
      ...BOX,
      allowedOrigins: ["http://localhost:3105", "https://mend-box.tailc79e49.ts.net:8443"],
    });
    const flags = flagsOf(fromEdge.outcome);
    expect(flags).toContain("--no-edge");
    expect(resolveSetupSettings(BOX, flags).allowedOrigins).toEqual([
      "https://mend-box.tailc79e49.ts.net:8443",
    ]);
  });

  it("offers an IPv6-only tailnet for the web and for SSH, bracketed in URLs (review 664-3)", async () => {
    const v6 = observe({
      tailscale: async () =>
        tailscaleFactsOf(
          JSON.stringify({
            BackendState: "Running",
            Self: { TailscaleIPs: ["fd7a:115c:a1e0::1"] },
          }),
          "",
        ),
      localAddresses: () => ["fd7a:115c:a1e0::1"],
    });
    // fresh · network · Tailscale (1) · URL: enter · SSH: over Tailscale (enter) · T3 · mirrors ·
    // tenancy · apply
    const fresh = await converse(["2", "1", "", "", "", "", "", ""], null, v6);
    expect(fresh.transcript).toContain("1. over Tailscale, as fd7a:115c:a1e0::1");
    expect(flagsOf(fresh.outcome)).toEqual([
      "--bind",
      "fd7a:115c:a1e0::1",
      "--url",
      "http://[fd7a:115c:a1e0::1]:3105",
      "--exposure",
      "private",
    ]);
    // A saved install on that address keeps it: enter all the way changes nothing.
    const { tenancy: _t, declared: _d, edgeHost: _e, sshBind: _s, ...rest } = BOX;
    const saved: ServerConfig = {
      ...rest,
      bind: "fd7a:115c:a1e0::1",
      appUrl: "http://box.tail1234.ts.net:3105",
      allowedOrigins: [],
      exposure: "private",
    };
    const again = await converse(["2", "1", "2", "", "", "", "", ""], saved, v6);
    expect(flagsOf(again.outcome)).toEqual([]);
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
    const { outcome, transcript } = await converse(
      ["2", "1", "", "", "y", "y", "", "2", "y"],
      null,
    );
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
      ipv6: "fd7a:115c:a1e0::1",
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
