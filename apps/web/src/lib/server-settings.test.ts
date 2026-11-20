import type { ExposureCase, ExposureGateItem, MultiModeGateCase } from "@mend/api-contracts";
import { refusedKeyReportFixture, serverBoatFactsFixture } from "@mend/domain/boat-key-fixtures";
import { describe, expect, it } from "vitest";

import {
  addressSentence,
  boatWords,
  type CheckContext,
  changeHow,
  creationWords,
  deploymentLine,
  exposureCheck,
  exposureGroups,
  exposureSetWith,
  gateCheck,
  gateGroups,
  gateInPlaceLine,
  goPublicLead,
  goPublicLine,
  imageExtras,
  imageName,
  inPlaceLine,
  keyedParts,
  organizationCounts,
  runSeveralLine,
  runtimeOffer,
  sealantConnected,
  sealantNeedsYou,
  sessionChannelWords,
  type Words,
  wordsText,
} from "./server-settings.ts";

const now = new Date(2026, 10, 19, 10, 50);
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

const local: CheckContext = { deployment: "local", address: "https://mend.northwind.dev" };
const helm: CheckContext = { deployment: "kubernetes", address: "https://mend.northwind.com" };

type Established = ExposureGateItem["established"];

/** An exposure item as the server sends it; the page never reads `detail` or `fix`. */
const exposure = (
  item: ExposureCase,
  established: Established,
  blocksStart = true,
): ExposureGateItem => ({
  ...item,
  established,
  blocksStart,
  detail: "the command line's sentence",
  fix: null,
});

const gate = (item: MultiModeGateCase, ok: boolean) => ({
  ...item,
  ok,
  detail: "the command line's sentence",
  fix: null,
});

const text = (words: Words | null) => (words === null ? null : wordsText(words));

const worded = (item: ExposureGateItem, context: CheckContext = local) => {
  const check = exposureCheck(item, context);
  return { title: check.title, saw: text(check.saw), fix: text(check.fix) };
};

describe("each exposure check, worded from its case and data", () => {
  it.each<[string, ExposureGateItem, { title: string; saw: string; fix: string | null }]>([
    [
      "https-origin, every address https",
      exposure({ id: "https-origin", reason: "all-https", originCount: 2 }, "observed"),
      {
        title: "Requests arrive over HTTPS",
        saw: "Every address browsers open Mend from uses HTTPS.",
        fix: null,
      },
    ],
    [
      "https-origin, plain origins",
      exposure(
        {
          id: "https-origin",
          reason: "plain-origins",
          origins: ["http://10.0.0.5:3105", "http://mend.lan"],
        },
        "open",
      ),
      {
        title: "Requests arrive over HTTPS",
        saw: "Browsers can still open Mend over plain HTTP from `http://10.0.0.5:3105` and `http://mend.lan`.",
        fix: "Set `APP_URL` and every entry in `MEND_ALLOWED_ORIGINS` to an https address.",
      },
    ],
    [
      "secure-cookies, http",
      exposure({ id: "secure-cookies", reason: "app-url-http" }, "open"),
      {
        title: "Sign-in cookies are HTTPS-only",
        saw: "Mend's sign-in cookies aren't marked Secure, because `APP_URL` starts with http, so a browser would send them over plain HTTP.",
        fix: "Set `APP_URL` to an https address.",
      },
    ],
    [
      "trusted-proxies, one range",
      exposure({ id: "trusted-proxies", reason: "ranges", rangeCount: 1 }, "observed"),
      {
        title: "Mend knows which proxies to trust",
        saw: "Mend trusts one proxy range to tell it each person's real address.",
        fix: null,
      },
    ],
    [
      "trusted-proxies, unset",
      exposure({ id: "trusted-proxies", reason: "unset" }, "open"),
      {
        title: "Mend knows which proxies to trust",
        saw: "`MEND_TRUSTED_PROXIES` isn't set, so Mend counts everyone who comes through your proxy as one address.",
        fix: "Set `MEND_TRUSTED_PROXIES` to the address ranges of your proxy and the web tier, and nothing wider.",
      },
    ],
    [
      "trusted-proxies, every address",
      exposure({ id: "trusted-proxies", reason: "trusts-every-address" }, "open"),
      {
        title: "Mend knows which proxies to trust",
        saw: "`MEND_TRUSTED_PROXIES` trusts every address, so anyone can tell Mend which address to count them as.",
        fix: "Set `MEND_TRUSTED_PROXIES` to the address ranges of your proxy and the web tier, and nothing wider.",
      },
    ],
    [
      "enrollment-closed, built in: says how to check it",
      exposure({ id: "enrollment-closed", reason: "built-in" }, "carried", false),
      {
        title: "Sign-up is closed",
        saw: "After the first account, people join only by invitation. This is built into this version of Mend, and the server can't see it working from inside.",
        fix: "To check it yourself, try to sign up without an invitation from another network. Mend should refuse.",
      },
    ],
    [
      "tenancy-gate, three missing",
      exposure(
        {
          id: "tenancy-gate",
          reason: "missing",
          missing: ["source-policy", "source-address-pinning", "upload-length-binding"],
          total: 10,
        },
        "open",
      ),
      {
        title: "Ready for several organizations",
        saw: "Three of the 10 things Mend needs before it runs several organizations are missing. They're listed under Organizations.",
        fix: "Fix them there, or run `mend operator gate` on the server to list them.",
      },
    ],
    [
      "budgets, one off",
      exposure({ id: "budgets", reason: "off", variables: ["MEND_BUDGET_BODY_BYTES"] }, "open"),
      {
        title: "Usage budgets are on",
        saw: "This budget is off: `MEND_BUDGET_BODY_BYTES`.",
        fix: "Unset each one to use its default, or set it to a positive number.",
      },
    ],
    [
      "no-bearers-in-urls, accepted",
      exposure({ id: "no-bearers-in-urls", reason: "accepted" }, "open"),
      {
        title: "Tokens stay out of addresses",
        saw: "Mend still accepts a sign-in token inside an address, for clients older than upgrade tickets.",
        fix: "Once the CLI, VS Code and phone builds you use are up to date, set `MEND_URL_BEARERS=refuse`.",
      },
    ],
    [
      "browser-headers, built in",
      exposure({ id: "browser-headers", reason: "built-in" }, "carried", false),
      {
        title: "Browser security headers",
        saw: "This version's web server sets the headers browsers read. The server can't see which web server is in front of it, so it can't check what browsers receive.",
        fix: "`mend doctor` against your address reads the headers a browser gets.",
      },
    ],
    [
      "error-redaction, verbose",
      exposure({ id: "error-redaction", reason: "verbose" }, "open"),
      {
        title: "Errors hide internal detail",
        saw: "`MEND_ERROR_DETAIL=verbose` is set, so error responses include detail from the services behind Mend.",
        fix: "Unset `MEND_ERROR_DETAIL`.",
      },
    ],
    [
      "executor-channel-transport, told private",
      exposure({ id: "executor-channel-transport", reason: "plain-http-private" }, "declared"),
      {
        title: "How workspaces connect to Mend",
        saw: "Workspaces reach their session over plain HTTP. You told Mend they do it over a private network (`MEND_EXECUTOR_NETWORK=private`). It can't check that.",
        fix: null,
      },
    ],
    [
      "executor-channel-transport, socket",
      exposure({ id: "executor-channel-transport", reason: "socket" }, "observed"),
      {
        title: "How workspaces connect to Mend",
        saw: "Workspaces reach their session over a socket on this machine, not over a network.",
        fix: null,
      },
    ],
    [
      "workspace-ssh, loopback",
      exposure(
        { id: "workspace-ssh", reason: "loopback", published: "127.0.0.1:2222" },
        "observed",
      ),
      {
        title: "Workspace SSH",
        saw: "Workspace SSH is published on `127.0.0.1:2222` only, on this machine.",
        fix: null,
      },
    ],
    [
      "workspace-ssh, published and open",
      exposure({ id: "workspace-ssh", reason: "published", published: "0.0.0.0:2222" }, "open"),
      {
        title: "Workspace SSH",
        saw: "Workspace SSH is published on `0.0.0.0:2222`, apart from the web address. Mend can't see who can reach that port.",
        fix: "Try to connect to `0.0.0.0:2222` from each network that shouldn't reach it. Then run `mend server setup --declare workspace-ssh`, or publish SSH on this machine only.",
      },
    ],
    [
      "workspace-ssh, published and told",
      exposure({ id: "workspace-ssh", reason: "published", published: "0.0.0.0:2222" }, "declared"),
      {
        title: "Workspace SSH",
        saw: "Workspace SSH is published on `0.0.0.0:2222`. You told Mend who can reach it. It can't check that.",
        fix: null,
      },
    ],
    [
      "core-private, open, with mirrors",
      exposure(
        { id: "core-private", reason: "outside-view", mirrors: ["npm:4873", "registry:5000"] },
        "open",
        false,
      ),
      {
        title: "Internal services are off the Internet",
        saw: "Mend can't see whether Sealant, its registry, the database or the package mirrors (`npm:4873` and `registry:5000`) can be reached from the Internet.",
        fix: "From outside your network, try to connect to each one. When none answers, run `mend server setup --declare core-private`.",
      },
    ],
    [
      "core-private, told",
      exposure({ id: "core-private", reason: "outside-view", mirrors: [] }, "declared", false),
      {
        title: "Internal services are off the Internet",
        saw: "You told Mend that Sealant, its registry and the database can't be reached from the Internet. It can't check that.",
        fix: null,
      },
    ],
    [
      "edge-tls, open: names the address the browser opened",
      exposure({ id: "edge-tls", reason: "outside-view" }, "open", false),
      {
        title: "HTTPS certificate and redirect",
        saw: "Mend can't see your proxy's certificate, whether it renews, or whether port 80 redirects to HTTPS.",
        fix: "Run `mend doctor` against `https://mend.northwind.dev` from another network. When it passes, run `mend server setup --declare edge-tls`.",
      },
    ],
    [
      "t3code-gateway, published wide",
      exposure({ id: "t3code-gateway", reason: "published", published: "10.0.0.5:3773" }, "open"),
      {
        title: "T3 Code gateway",
        saw: "The T3 Code gateway's port is published on `10.0.0.5:3773`. Every device pairs through Mend, but Mend can't see who can reach the port.",
        fix: "Try to connect to `10.0.0.5:3773` from each network that shouldn't reach it, then run `mend server setup --declare t3code-gateway`, or publish the port on this machine only.",
      },
    ],
    [
      "t3code-gateway, behind the proxy",
      exposure(
        {
          id: "t3code-gateway",
          reason: "edge",
          published: "127.0.0.1:3773",
          url: "https://t3.northwind.dev",
        },
        "open",
        false,
      ),
      {
        title: "T3 Code gateway",
        saw: "Your proxy serves the T3 Code gateway at `https://t3.northwind.dev`. Mend can't see that address's certificate.",
        fix: "Open `https://t3.northwind.dev/.well-known/t3/environment` from another network and check its certificate. When it passes, run `mend server setup --declare t3code-gateway`.",
      },
    ],
    [
      "t3code-gateway, where wasn't said",
      exposure({ id: "t3code-gateway", reason: "not-said" }, "open", false),
      {
        title: "T3 Code gateway",
        saw: "The T3 Code gateway is on, on a port of its own, but where it's published wasn't set (`MEND_T3_GATEWAY_PUBLISHED`).",
        fix: "Try to connect to the gateway's port from each network that shouldn't reach it, then run `mend server setup --declare t3code-gateway`.",
      },
    ],
    [
      "reassessment, none",
      exposure({ id: "reassessment", reason: "none", version: "0.36.0" }, "open", false),
      {
        title: "Security review of this version",
        saw: "Mend knows of no independent security review of `0.36.0`.",
        fix: "After an independent security review of this exact release, set `MEND_EXPOSURE_REASSESSED=0.36.0`. Each upgrade needs a new review.",
      },
    ],
    [
      "reassessment, an older one",
      exposure(
        { id: "reassessment", reason: "older", version: "0.36.0", reviewed: "0.35.2" },
        "open",
        false,
      ),
      {
        title: "Security review of this version",
        saw: "The last review Mend knows of is for `0.35.2`, and this server runs `0.36.0`.",
        fix: "After an independent security review of this exact release, set `MEND_EXPOSURE_REASSESSED=0.36.0`. Each upgrade needs a new review.",
      },
    ],
    [
      "reassessment, unversioned",
      exposure({ id: "reassessment", reason: "unversioned" }, "open", false),
      {
        title: "Security review of this version",
        saw: "This build has no version number, so no review can name it.",
        fix: "Run a released build.",
      },
    ],
  ])("%s", (_, item, expected) => {
    expect(worded(item)).toEqual(expected);
  });

  it("on Kubernetes, names the Helm values where one machine names a variable or setup", () => {
    expect(
      worded(exposure({ id: "edge-tls", reason: "outside-view" }, "open", false), helm).fix,
    ).toBe(
      "Run `mend doctor` against `https://mend.northwind.com` from another network. When it passes, add `edge-tls` to `exposure.declared` in your Helm values.",
    );
    expect(
      worded(exposure({ id: "no-bearers-in-urls", reason: "accepted" }, "open"), helm).fix,
    ).toBe(
      "Once the CLI, VS Code and phone builds you use are up to date, set `exposure.refuseUrlBearers: true` in your Helm values.",
    );
    expect(worded(exposure({ id: "trusted-proxies", reason: "unset" }, "open"), helm).fix).toBe(
      "Set `api.trustedProxyCidrs` in your Helm values to the address ranges of your proxy and the web tier, and nothing wider.",
    );
    // Helm's `exposure.declared` doesn't take workspace-ssh: setup stays the way to say it.
    expect(
      worded(
        exposure({ id: "workspace-ssh", reason: "published", published: "0.0.0.0:2222" }, "open"),
        helm,
      ).fix,
    ).toContain("run `mend server setup --declare workspace-ssh`");
  });

  it("says 'your address' while the page doesn't know it yet", () => {
    expect(
      worded(exposure({ id: "edge-tls", reason: "outside-view" }, "open", false), {
        deployment: null,
        address: "",
      }).fix,
    ).toContain("Run `mend doctor` against your address from another network.");
  });

  describe("previews", () => {
    const preview = (
      item: Extract<ExposureCase, { id: "preview-gateway" }>,
      established: Established,
    ) => worded(exposure(item, established));

    it("in place: where previews are served, and the cookie rule on a shared site", () => {
      expect(
        preview(
          {
            id: "preview-gateway",
            reason: "domain-https",
            pattern: "https://<label>.previews.northwind.dev",
            domain: "previews.northwind.dev",
            sharedSite: "northwind.dev",
            problems: [],
            outside: "declared",
          },
          "declared",
        ),
      ).toEqual({
        title: "Previews",
        saw: "Previews are served at `https://<label>.previews.northwind.dev`, apart from Mend's own address. Mend's cookies start with `__Host-`, so a preview can't set them. You told Mend the wildcard DNS and certificate for `*.previews.northwind.dev` are in place, and who can reach the gateway's port. It can't check that.",
        fix: null,
      });
      expect(
        preview(
          {
            id: "preview-gateway",
            reason: "loopback-http",
            pattern: "http://<label>.localhost:3130",
            problems: [],
            outside: "none",
          },
          "observed",
        ).saw,
      ).toBe(
        "Previews are served at `http://<label>.localhost:3130`, apart from Mend's own address.",
      );
    });

    it("not in place: one sentence for each way they fall short, and a fix for each", () => {
      expect(
        preview(
          {
            id: "preview-gateway",
            reason: "domain-https",
            pattern: "https://<label>.northwind.dev",
            domain: "northwind.dev",
            sharedSite: null,
            problems: [
              {
                kind: "domain-overlap",
                host: "mend.northwind.dev",
                domain: "northwind.dev",
                overlap: "under",
              },
            ],
            outside: "open",
          },
          "open",
        ),
      ).toEqual({
        title: "Previews",
        saw: "Mend's address `mend.northwind.dev` sits under `northwind.dev`. Mend can't see the wildcard DNS and certificate for `*.northwind.dev`, or who reaches the gateway's port.",
        fix: "Set `MEND_PREVIEW_DOMAIN` to a domain apart from Mend's. Open a preview from another network, then run `mend server setup --declare preview-gateway`.",
      });
      expect(
        preview(
          {
            id: "preview-gateway",
            reason: "loopback-http",
            pattern: "http://<label>.localhost:3130",
            problems: [
              {
                kind: "plain-http",
                url: "http://<label>.localhost:3130",
                because: "exposure-not-loopback",
              },
            ],
            outside: "none",
          },
          "open",
        ),
      ).toEqual({
        title: "Previews",
        saw: "Previews are plain HTTP at `http://<label>.localhost:3130`, and this server isn't set to this machine only.",
        fix: "Set `MEND_PREVIEW_DOMAIN` to serve previews over HTTPS behind your proxy.",
      });
    });
  });
});

describe("each multi mode gate item, worded from its case and data", () => {
  it.each<[string, ReturnType<typeof gate>, { title: string; saw: string; fix: string | null }]>([
    [
      "source-policy, operator",
      gate({ id: "source-policy", reason: "operator" }, false),
      {
        title: "Mend's git stays off private networks",
        saw: "Mend's own git follows the operator source policy, so it can fetch from private and local addresses.",
        fix: "Set `MEND_SOURCE_POLICY=tenant`. That also fixes the next one.",
      },
    ],
    [
      "source-address-pinning, tenant",
      gate({ id: "source-address-pinning", reason: "tenant" }, true),
      {
        title: "Git connects to the address it checked",
        saw: "Git connects to the exact address the source policy checked, over SSH and HTTPS.",
        fix: null,
      },
    ],
    [
      "folders-reach-workspaces, colocated",
      gate({ id: "folders-reach-workspaces", reason: "colocated" }, true),
      {
        title: "Folders reach workspaces",
        saw: "Folders and references are mounted beside each worktree.",
        fix: null,
      },
    ],
    [
      "upload-length-binding, no sizes",
      gate({ id: "upload-length-binding", reason: "no-sizes" }, false),
      {
        title: "Uploads are held to their size",
        saw: "Mend accepts uploads from workspaces that don't say how big they are.",
        fix: "Set `MEND_CAPTURE_REQUIRE_SIZES=true`, and use an S3-compatible bucket for `MEND_BLOB_STORE`.",
      },
    ],
    [
      "upload-length-binding, a directory store",
      gate({ id: "upload-length-binding", reason: "directory-store" }, false),
      {
        title: "Uploads are held to their size",
        saw: "Mend asks for sizes, but a directory store can't enforce them.",
        fix: "Use an S3-compatible bucket for `MEND_BLOB_STORE`.",
      },
    ],
    [
      "transport-bound-to-origin, unbound",
      gate({ id: "transport-bound-to-origin", reason: "unbound" }, false),
      {
        title: "Workspace git signs only for its own remote",
        saw: "A workspace's git can sign requests for any remote.",
        fix: "Unset `MEND_GIT_TRANSPORT_BIND_ORIGIN`.",
      },
    ],
    [
      "raw-service-ports, exposed",
      gate({ id: "raw-service-ports", reason: "exposed", addresses: ["0.0.0.0"] }, false),
      {
        title: "Service ports stay on this machine",
        saw: "Services in workspaces listen on `0.0.0.0`, where anyone who reaches the port reaches the service without signing in.",
        fix: "Unset `MEND_SERVICE_HOSTS`.",
      },
    ],
    [
      "operator-present, one",
      gate({ id: "operator-present", reason: "operators", count: 1 }, true),
      {
        title: "The server has an operator",
        saw: "One account holds the operator role.",
        fix: null,
      },
    ],
    [
      "operator-present, none",
      gate({ id: "operator-present", reason: "operators", count: 0 }, false),
      {
        title: "The server has an operator",
        saw: "No account holds the operator role.",
        fix: "Give an account the operator role.",
      },
    ],
  ])("%s", (_, item, expected) => {
    const check = gateCheck(item);
    expect({ title: check.title, saw: text(check.saw), fix: text(check.fix) }).toEqual(expected);
  });
});

describe("where each check goes on the page", () => {
  const items: ReadonlyArray<ExposureGateItem> = [
    exposure({ id: "https-origin", reason: "all-https", originCount: 1 }, "observed"),
    exposure({ id: "edge-tls", reason: "outside-view" }, "open", false),
    exposure({ id: "no-bearers-in-urls", reason: "accepted" }, "open"),
    exposure({ id: "reassessment", reason: "none", version: "0.36.0" }, "open", false),
    exposure({ id: "enrollment-closed", reason: "built-in" }, "carried", false),
  ];

  it("on a private server, nothing needs you: open checks are what going public would change, the ones that stop a start first", () => {
    const groups = exposureGroups({ declared: "private", items }, local);
    expect(groups.needsYou).toEqual([]);
    expect(groups.toGoPublic.map((check) => check.id)).toEqual([
      "no-bearers-in-urls",
      "edge-tls",
      "reassessment",
    ]);
    expect(groups.inPlace.map((check) => check.id)).toEqual(["https-origin", "enrollment-closed"]);
  });

  it("on a public server, every open check needs you, whether or not it stops a start", () => {
    const groups = exposureGroups({ declared: "public", items }, local);
    expect(groups.needsYou.map((check) => check.id)).toEqual([
      "no-bearers-in-urls",
      "edge-tls",
      "reassessment",
    ]);
    expect(groups.toGoPublic).toEqual([]);
  });

  it("the gate: missing items need you only on a server running several organizations", () => {
    const gateItems = [
      gate({ id: "source-policy", reason: "operator" }, false),
      gate({ id: "operator-present", reason: "operators", count: 1 }, true),
    ];
    expect(gateGroups(gateItems, "single").toRunSeveral.map((check) => check.id)).toEqual([
      "source-policy",
    ]);
    expect(gateGroups(gateItems, "single").needsYou).toEqual([]);
    expect(gateGroups(gateItems, "multi").needsYou.map((check) => check.id)).toEqual([
      "source-policy",
    ]);
  });
});

describe("the closed lines and the line over the list", () => {
  const check = (blocksStart: boolean) =>
    exposureCheck(exposure({ id: "edge-tls", reason: "outside-view" }, "open", blocksStart), local);

  it("counts what going public would change, and which of them stop a start", () => {
    expect(goPublicLine(5)).toBe(
      "Before this server could go public, 5 things would have to change.",
    );
    expect(goPublicLine(1)).toBe(
      "Before this server could go public, one thing would have to change.",
    );
    expect(goPublicLead([check(true), check(true), check(false), check(false), check(false)])).toBe(
      "Mend won't start in public until the first two change. It can't check the other three for itself.",
    );
    expect(goPublicLead([check(true), check(false)])).toBe(
      "Mend won't start in public until the first one changes. It can't check the other one for itself.",
    );
    expect(goPublicLead([check(true), check(true)])).toBe(
      "Mend won't start in public until they change.",
    );
    expect(goPublicLead([check(false), check(false), check(false)])).toBe(
      "None of them stops Mend starting in public. Mend can't check them for itself.",
    );
  });

  it("says all are in place when none is open, and 'other' beside a list", () => {
    expect(inPlaceLine(14, 14)).toBe("All 14 checks are in place.");
    expect(inPlaceLine(9, 14)).toBe("9 other checks are in place.");
    expect(inPlaceLine(1, 3)).toBe("One other check is in place.");
    expect(runSeveralLine(3)).toBe(
      "Before this server could run several organizations, 3 things would have to change.",
    );
    expect(gateInPlaceLine(10, 10)).toBe(
      "All 10 things Mend needs to run several organizations are in place.",
    );
    expect(gateInPlaceLine(7, 10)).toBe("7 other items are in place.");
  });

  it("says where the exposure is set, on one machine and on Kubernetes", () => {
    expect(wordsText(exposureSetWith("local"))).toBe("Set with `mend server setup --exposure`.");
    expect(wordsText(exposureSetWith("kubernetes"))).toBe(
      "Set with `exposure.mode` in your Helm values.",
    );
    expect(wordsText(exposureSetWith(null))).toBe("Set with `MEND_EXPOSURE`.");
  });
});

describe("Sealant", () => {
  const at = "http://sealant:8080";

  it("connected: one sentence, and nothing for Needs you", () => {
    const connected = {
      status: "connected",
      baseUrl: at,
      detail: null,
      checkedAt: minutesAgo(2),
    } as const;
    expect(sealantConnected(connected, now)).toBe(
      "Sealant runs every workspace. Mend reached it 2 minutes ago.",
    );
    expect(sealantNeedsYou(connected, now, "local")).toBeNull();
  });

  it("unreachable: what Mend asked, what it saw, and where to look on one machine or in a cluster", () => {
    const unreachable = {
      status: "unreachable",
      baseUrl: at,
      detail: "connect ECONNREFUSED 172.18.0.4:8080",
      checkedAt: minutesAgo(1),
    } as const;
    const words = sealantNeedsYou(unreachable, now, "local");
    expect(words).toMatchObject({
      title: "Sealant can't be reached",
      word: "Unreachable",
      recheck: "sealant",
    });
    expect(text(words?.saw ?? null)).toBe(
      "Mend couldn't reach Sealant when it checked, 1 minute ago. Sealant runs every workspace, so no new session can start.",
    );
    expect(text(words?.asked ?? null)).toBe(
      "Mend asked at `http://sealant:8080` and saw `connect ECONNREFUSED 172.18.0.4:8080`.",
    );
    expect(text(words?.fix ?? null)).toBe(
      "On the server, `mend server logs --tail 200` shows what Sealant said, and `mend server restart` starts it again.",
    );
    expect(text(sealantNeedsYou(unreachable, now, "kubernetes")?.fix ?? null)).toBe(
      "Read the Sealant pod's logs in your cluster to see what it said.",
    );
  });

  it("a refused key says so and never shows the key or Sealant's answer about it", () => {
    const words = sealantNeedsYou(
      { status: "unauthorized", baseUrl: at, detail: "401 key sk_live_x", checkedAt: now },
      now,
      "local",
    );
    expect(words).toMatchObject({
      title: "Sealant refused this server's key",
      word: "Key refused",
    });
    expect(text(words?.asked ?? null)).toBe("Mend asked at `http://sealant:8080`.");
    expect(text(words?.fix ?? null)).toBe("Give the server a new key with `mend server setup`.");
  });

  it("something that isn't Sealant answering", () => {
    expect(
      sealantNeedsYou(
        { status: "mismatched", baseUrl: at, detail: null, checkedAt: now },
        now,
        "local",
      ),
    ).toMatchObject({ title: "Something else answers at Sealant's address", word: "Not Sealant" });
  });
});

describe("Boat", () => {
  it("everything answered: sentences for the Boat row, nothing for Needs you", () => {
    const words = boatWords(serverBoatFactsFixture({}, minutesAgo(4)), now);
    expect(words.needsYou).toEqual([]);
    expect(words.sentences.map(wordsText)).toEqual([
      "Boat workspaces reach this server at `https://mend.example.ts.net:8443` and save their work to `https://mend.example.ts.net:10000`. Both answered when this server asked, 4 minutes ago.",
      expect.stringMatching(
        /^This server has a Boat key of its own\. Sealant checked it with Boat today at .+: it bills the acme-boat wallet and can start a VM\.$/,
      ),
      "Sealant can launch Boat workspaces, and they can reach project resources such as `@db`.",
    ]);
  });

  it("a refused server key goes to Needs you with its check, and the row points there", () => {
    const facts = serverBoatFactsFixture(
      {
        serverKey: {
          state: "held",
          unreachable: null,
          report: refusedKeyReportFixture(minutesAgo(30)),
        },
      },
      minutesAgo(30),
    );
    const words = boatWords(facts, now);
    expect(words.sentences.map(wordsText)).toContain(
      "Boat refused this server's own key when Sealant last checked it. What to do is under Needs you.",
    );
    expect(words.needsYou).toHaveLength(1);
    expect(words.needsYou[0]).toMatchObject({
      title: "Boat refused this server's key",
      word: "Key refused",
      recheck: "boat-key",
    });
    expect(text(words.needsYou[0]?.fix ?? null)).toBe(
      "Make a new key in Boat, then give it to the server with `mend server setup --boat-api-key-stdin`.",
    );
  });

  it("an address that didn't answer, and a worker without the resource gateway, each need you", () => {
    const facts = serverBoatFactsFixture(
      {
        addresses: [
          {
            purpose: "saved-work",
            url: "https://saved.northwind.dev",
            answer: { answered: false, detail: "connect ETIMEDOUT" },
            observedAt: minutesAgo(3),
          },
        ],
        serverKey: { state: "none" },
        launch: { state: "listed", observedAt: now, resourceGateway: false },
      },
      now,
    );
    const words = boatWords(facts, now);
    expect(words.needsYou.map((item) => item.title)).toEqual([
      "Boat can't reach this server",
      "Boat workspaces can't reach project resources",
    ]);
    expect(text(words.needsYou[0]?.saw ?? null)).toBe(
      "`https://saved.northwind.dev`, where Boat workspaces save their work, didn't answer when this server asked, 3 minutes ago.",
    );
    expect(words.sentences.map(wordsText)).toContain(
      "This server has no Boat key of its own. Each organization's Boat sessions run on the key its owner connects.",
    );
  });
});

describe("this server and what it offers", () => {
  it("says how the address is served, from what the server saw", () => {
    expect(
      addressSentence({
        originScheme: "https",
        originOnMachine: false,
        arrivedVia: "trusted-proxy",
      }),
    ).toBe("Served over HTTPS, through a proxy this server trusts.");
    expect(
      addressSentence({ originScheme: "http", originOnMachine: true, arrivedVia: "direct" }),
    ).toBe("Served over plain HTTP, at an address on this machine.");
    expect(
      addressSentence({ originScheme: "https", originOnMachine: false, arrivedVia: "direct" }),
    ).toBe("Served over HTTPS, straight to this server.");
  });

  it("says where the server runs, how workspaces reach it and how to change it", () => {
    const health = {
      version: "0.37.0",
      deploymentMode: "local",
      sessionChannel: { mode: "unix-socket", endpoint: null },
    } as const;
    expect(deploymentLine(health, "mend-prod")).toBe("One machine, mend-prod, with Docker");
    expect(deploymentLine({ ...health, deploymentMode: "kubernetes" }, "mend-prod")).toBe(
      "Kubernetes",
    );
    expect(wordsText(sessionChannelWords(health.sessionChannel))).toBe(
      "A socket per session, on this machine",
    );
    expect(
      wordsText(sessionChannelWords({ mode: "network", endpoint: "https://boat.northwind.dev" })),
    ).toBe("Over the network, at `https://boat.northwind.dev`");
    expect(changeHow("local")).toBe("run mend server setup on the server");
    expect(changeHow("kubernetes")).toBe("edit your Helm values and upgrade the release");
  });

  it("says which runtimes are offered and where new organizations start", () => {
    const offer = { offered: ["docker", "boat"] as const, default: "boat" as const };
    expect(runtimeOffer("boat", offer)).toEqual({ word: "Offered", startsHere: true });
    expect(runtimeOffer("docker", offer)).toEqual({ word: "Offered", startsHere: false });
    expect(runtimeOffer("boat", { offered: ["docker"], default: "docker" })).toEqual({
      word: "Not offered",
      startsHere: false,
    });
  });

  it("names the image by what it is, and says what it adds", () => {
    const family = {
      mode: "family",
      os: "ubuntu",
      shell: "zsh",
      packages: ["pnpm", "jq"],
      services: { docker: true },
      screen: true,
    } as const;
    expect(imageName(family)).toBe("Ubuntu, with zsh");
    expect(imageExtras(family)).toBe("Docker inside workspaces, and a screen agents can drive.");
    const custom = {
      mode: "custom",
      baseImage: "ghcr.io/northwind/dev:2026.11",
      packages: [],
      setupCommands: [],
      services: { docker: false },
    } as const;
    expect(imageName(custom)).toBe("ghcr.io/northwind/dev:2026.11");
    expect(imageExtras(custom)).toBe("No Docker inside workspaces.");
  });

  it("counts members and owners, and says when an organization has no owner", () => {
    expect(organizationCounts({ memberCount: 4, ownerCount: 2 })).toBe("4 members, 2 owners");
    expect(organizationCounts({ memberCount: 1, ownerCount: 0 })).toBe("1 member, no owner");
    expect(creationWords(true).word).toBe("Anyone signed in");
    expect(creationWords(false).word).toBe("Only operators");
  });
});

describe("words in a list", () => {
  it("keys each part apart, even when the same fact comes twice", () => {
    const keys = keyedParts([
      "Set ",
      { code: "MEND_SOURCE_POLICY=tenant" },
      " and ",
      { code: "MEND_SOURCE_POLICY=tenant" },
      " and ",
    ]).map((part) => part.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
