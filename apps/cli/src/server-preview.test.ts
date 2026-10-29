import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hasOpenssl, makeCertificate } from "../test-fixtures/preview-certificate.ts";
import type { ServerPreview } from "./server-edge.ts";
import {
  checkPreviewCertificate,
  observeTailnet,
  parsePreviewFile,
  type PreviewContext,
  previewDomainProblem,
  resolvePreview,
  tailnetAppUrlProblem,
  tailnetServeLines,
} from "./server-preview.ts";
import { ServerSetupError } from "./server-setup-error.ts";
import { tailscaleFactsOf } from "./server-setup-guide.ts";

const directories: Array<string> = [];
const scratch = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mend-preview-cert-"));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true });
});

describe("a preview domain beside Mend's hosts", () => {
  const mend = [
    { host: "mend.example.com", what: "the edge's host" },
    { host: "t3.example.org", what: "the t3code gateway's origin" },
  ];

  it.each([
    ["Mend's own host", "mend.example.com", "holds the edge's host mend.example.com"],
    ["a domain above it", "example.com", "holds the edge's host mend.example.com"],
    ["a domain under it", "previews.mend.example.com", "is under the edge's host mend.example.com"],
    ["the t3code gateway's origin", "t3.example.org", "holds the t3code gateway's origin"],
  ])("refuses %s", (_, domain, words) => {
    expect(previewDomainProblem(domain, mend, "https://mend.example.com")).toContain(words);
  });

  it("takes a sibling on Mend's own site while Mend's URL is https", () => {
    expect(
      previewDomainProblem("previews.example.com", mend, "https://mend.example.com"),
    ).toBeNull();
  });

  it("refuses a sibling on Mend's own site while Mend's URL is http, and says why", () => {
    expect(previewDomainProblem("previews.example.com", mend, "http://mend.example.com")).toBe(
      "--preview-domain previews.example.com is on Mend's own site, example.com, and Mend's URL is http://mend.example.com. Over http Mend's cookies cannot be __Host-, so a page on a preview could set a session cookie Mend reads as its own: a preview domain on Mend's own site needs Mend's URL on https. Serve Mend over https, or give previews a registrable domain of their own.",
    );
  });

  it("takes a registrable domain of its own", () => {
    expect(
      previewDomainProblem("previews.example.net", mend, "http://mend.example.com"),
    ).toBeNull();
  });
});

describe("a certificate or key path", () => {
  it("is absolute, with nothing Compose or server.env would split", () => {
    expect(parsePreviewFile("/etc/mend/previews.crt")).toBe("/etc/mend/previews.crt");
    expect(parsePreviewFile("/etc/mend/../mend/previews.crt")).toBe("/etc/mend/previews.crt");
    expect(parsePreviewFile("/Users/maria/Application Support/previews.crt")).toBe(
      "/Users/maria/Application Support/previews.crt",
    );
    for (const refused of [
      "previews.crt",
      "./previews.crt",
      "/etc/mend#files/previews.crt",
      "/etc/mend\nfiles/previews.crt",
      "/etc/mend:ro/previews.crt",
      "/etc/$HOME/previews.crt",
      '/etc/"mend"/previews.crt',
    ])
      expect(parsePreviewFile(refused), refused).toBeNull();
  });
});

const problem = (preview: Parameters<typeof checkPreviewCertificate>[0]) => {
  const checked = checkPreviewCertificate(preview);
  return checked._tag === "Refused" ? checked.problem : null;
};

describe.skipIf(!hasOpenssl)("the supplied certificate, as setup reads it", () => {
  const domain = "previews.example.net";

  it("loads when it is for *.<domain> and the key is its own, and says until when", () => {
    const files = makeCertificate(scratch(), [`*.${domain}`]);
    const checked = checkPreviewCertificate({ domain, ...files });
    expect(checked).toMatchObject({
      _tag: "Loaded",
      pem: {
        certificate: fs.readFileSync(files.certificate, "utf8"),
        key: fs.readFileSync(files.key, "utf8"),
      },
    });
    const days =
      checked._tag === "Loaded" ? (checked.validTo.getTime() - Date.now()) / 86_400_000 : 0;
    expect(Math.round(days)).toBe(90);
  });

  it("refuses a certificate for other names, only the probe name, another certificate's key and a missing file", () => {
    const directory = scratch();
    const other = makeCertificate(directory, ["mend.example.com"], "other");
    const probeOnly = makeCertificate(directory, [`mend-preview-probe.${domain}`], "probe");
    const wildcard = makeCertificate(directory, [`*.${domain}`]);
    expect(problem({ domain, ...other })).toContain(`is not for *.${domain}`);
    expect(problem({ domain, ...probeOnly })).toBe(
      `${probeOnly.certificate} is not for *.${domain} (its names: DNS:mend-preview-probe.${domain}). Each preview is a host under the domain, so the certificate needs that wildcard.`,
    );
    expect(problem({ domain, certificate: wildcard.certificate, key: other.key })).toContain(
      `is not the key of ${wildcard.certificate}`,
    );
    expect(
      problem({ domain, certificate: path.join(directory, "absent.crt"), key: wildcard.key }),
    ).toContain("cannot be read from this machine");
    expect(problem({ domain, certificate: wildcard.key, key: wildcard.key })).toContain(
      "holds no PEM certificate",
    );
  });
});

const TAILNET_STATUS = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "mend-box.tailc79e49.ts.net." },
  CurrentTailnet: { MagicDNSSuffix: "tailc79e49.ts.net", MagicDNSEnabled: true },
});

describe("Tailscale on the machine that runs Mend", () => {
  it("refuses when MagicDNS is off, though the tailnet still reports its suffix", async () => {
    const off = JSON.stringify({
      BackendState: "Running",
      Self: { DNSName: "mend-box.tailc79e49.ts.net." },
      CurrentTailnet: { MagicDNSSuffix: "tailc79e49.ts.net", MagicDNSEnabled: false },
    });
    expect(
      await observeTailnet(async () => tailscaleFactsOf(off, ""), "unix:///var/run/docker.sock"),
    ).toEqual({
      _tag: "Refused",
      problem:
        "Observed: MagicDNS is off for this machine's tailnet, and the previews' name is mend-preview.tailc79e49.ts.net. Turn MagicDNS on in the Tailscale admin console (DNS), then run mend server setup --preview-tailnet again.",
    });
  });

  it("names the gateway mend-preview.<MagicDNS suffix>, and keeps what tailscale serve serves for the Service", async () => {
    const serve = JSON.stringify({
      Services: {
        "svc:mend-preview": {
          TCP: { "20001": { HTTPS: true } },
          Web: {
            "mend-preview.tailc79e49.ts.net:20001": {
              Handlers: { "/": { Proxy: "http://127.0.0.1:3130" } },
            },
          },
        },
      },
    });
    expect(
      await observeTailnet(
        async () => tailscaleFactsOf(TAILNET_STATUS, serve),
        "unix:///var/run/docker.sock",
      ),
    ).toEqual({
      _tag: "Observed",
      hostname: "mend-preview.tailc79e49.ts.net",
      self: "mend-box.tailc79e49.ts.net",
      served: [
        {
          origin: "https://mend-preview.tailc79e49.ts.net:20001",
          port: 20001,
          loopbackPort: 3130,
          upstream: "http://127.0.0.1:3130/",
          listener: "https",
          funnel: false,
        },
      ],
    });
  });

  it("refuses a Docker engine on another machine without asking this machine's tailscale", async () => {
    let asked = false;
    const observed = await observeTailnet(async () => {
      asked = true;
      return tailscaleFactsOf(TAILNET_STATUS, "");
    }, "ssh://mend@box");
    expect(observed).toEqual({
      _tag: "Refused",
      problem:
        "Docker here is ssh://mend@box, another machine. Previews on the tailnet are served by tailscale serve on the machine that runs Mend, and the tailscale on this machine describes this one. Run mend server setup --preview-tailnet on the machine that runs Mend.",
    });
    expect(asked).toBe(false);
  });
});

const offeredUpstream = (bind: string) =>
  /tailscale serve --bg --https=443 (\S+)\./.exec(
    tailnetAppUrlProblem({ appUrl: "http://localhost:3105", bind, appPort: 3105 }, null) ?? "",
  )?.[1];

/** What setup refused, in its own words. */
const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (cause) {
    if (cause instanceof ServerSetupError) return cause.message;
    throw cause;
  }
  return "";
};

describe("previews on the tailnet, as setup resolves them", () => {
  const mend: PreviewContext = {
    edgeHost: undefined,
    hosts: [{ host: "mend-box.tailc79e49.ts.net", what: "Mend's origin's host" }],
    ports: [3105, 2222],
    exposure: "private",
    declared: [],
    appUrl: "https://mend-box.tailc79e49.ts.net",
    bind: "127.0.0.1",
    appPort: 3105,
    tailnet: {
      _tag: "Observed",
      hostname: "mend-preview.tailc79e49.ts.net",
      self: "mend-box.tailc79e49.ts.net",
      served: null,
    },
  };
  const hostname = "mend-preview.tailc79e49.ts.net";

  it("takes the default ports, the one set the server reads too", () => {
    expect(resolvePreview(undefined, { _tag: "Tailnet", ports: undefined }, mend)).toEqual({
      mode: "tailnet",
      hostname: "mend-preview.tailc79e49.ts.net",
      ports: Array.from({ length: 16 }, (_, index) => 20001 + index),
    });
  });

  it("is refused under --exposure public, which needs a registrable domain", () => {
    expect(
      refusal(() =>
        resolvePreview(
          undefined,
          { _tag: "Tailnet", ports: [20001] },
          {
            ...mend,
            exposure: "public",
          },
        ),
      ),
    ).toBe(
      "Previews on the tailnet are for a private instance: under --exposure public, previews need a registrable domain of their own (--preview-domain, behind the edge), and a tailnet's names are not one. Keep the exposure private, or turn tailnet previews off with --no-preview-tailnet.",
    );
    expect(
      refusal(() =>
        resolvePreview(
          { mode: "tailnet", hostname, ports: [20001] },
          {
            _tag: "Keep",
          },
          { ...mend, exposure: "public" },
        ),
      ),
    ).toContain("--no-preview-tailnet (they are on now)");
  });

  it("refuses where Tailscale said no, saved name or not, and keeps the saved name only when it was not asked", () => {
    const stopped = {
      ...mend,
      tailnet: { _tag: "Refused", problem: "Observed: Tailscale on this machine is not running." },
    } as const;
    const saved: ServerPreview = { mode: "tailnet", hostname, ports: [20001] };
    expect(
      refusal(() => resolvePreview(saved, { _tag: "Tailnet", ports: [20001, 20002] }, stopped)),
    ).toBe("Observed: Tailscale on this machine is not running.");
    expect(refusal(() => resolvePreview(saved, { _tag: "Keep" }, stopped))).toBe(
      "Observed: Tailscale on this machine is not running.",
    );
  });

  it("refuses to turn on where Tailscale said no, and keeps the saved name when it was not asked", () => {
    expect(
      refusal(() =>
        resolvePreview(
          undefined,
          { _tag: "Tailnet", ports: undefined },
          {
            ...mend,
            tailnet: {
              _tag: "Refused",
              problem: "Observed: tailscale did not answer on this machine.",
            },
          },
        ),
      ),
    ).toBe("Observed: tailscale did not answer on this machine.");
    expect(
      resolvePreview(
        { mode: "tailnet", hostname: "mend-preview.old.ts.net", ports: [20001] },
        { _tag: "Keep" },
        { ...mend, tailnet: undefined },
      ),
    ).toEqual({ mode: "tailnet", hostname: "mend-preview.old.ts.net", ports: [20001] });
  });

  it("refuses a gateway name that is Mend's own host", () => {
    expect(
      refusal(() =>
        resolvePreview(
          undefined,
          { _tag: "Tailnet", ports: undefined },
          {
            ...mend,
            hosts: [{ host: "mend-preview.tailc79e49.ts.net", what: "Mend's origin's host" }],
          },
        ),
      ),
    ).toContain("mend-preview.tailc79e49.ts.net is Mend's origin's host");
  });

  it("each --no- flag turns off its own mode only", () => {
    const saved: ServerPreview = { mode: "tailnet", hostname, ports: [20001] };
    expect(resolvePreview(saved, { _tag: "Off", modes: ["domain"] }, mend)).toEqual(saved);
    expect(resolvePreview(saved, { _tag: "Off", modes: ["tailnet"] }, mend)).toBeUndefined();
  });

  it("offers the https command on the loopback address Mend is published on, and loopback for a wildcard", () => {
    expect(offeredUpstream("::1")).toBe("http://[::1]:3105");
    expect(offeredUpstream("127.0.0.2")).toBe("http://127.0.0.2:3105");
    expect(offeredUpstream("127.0.0.1")).toBe("http://127.0.0.1:3105");
    expect(offeredUpstream("0.0.0.0")).toBe("http://127.0.0.1:3105");
    expect(offeredUpstream("::")).toBe("http://[::1]:3105");
  });

  it("needs Mend's own URL on https, and says how to serve it from where it is published", () => {
    expect(tailnetAppUrlProblem(mend, null)).toBeNull();
    expect(
      tailnetAppUrlProblem(
        { appUrl: "http://100.94.101.28:3105", bind: "100.94.101.28", appPort: 3105 },
        null,
      ),
    ).toContain(
      "tailscale serve --bg --https=443 http://100.94.101.28:3105. Then run mend server setup --url https://<this machine's MagicDNS name> --preview-tailnet.",
    );
    expect(
      tailnetAppUrlProblem(
        { appUrl: "http://100.94.101.28:3105", bind: "0.0.0.0", appPort: 3105 },
        "mend-box.tailc79e49.ts.net",
      ),
    ).toContain(
      "tailscale serve --bg --https=443 http://127.0.0.1:3105. Then run mend server setup --url https://mend-box.tailc79e49.ts.net --preview-tailnet.",
    );
  });
});

const route = (
  port: number,
  upstream: string | null,
  listener: "https" | "http" | "tcp" | null = "https",
) => ({
  origin: `https://mend-preview.tailc79e49.ts.net:${port}`,
  port,
  loopbackPort: 3130,
  upstream,
  listener,
  funnel: false,
});

describe("what tailscale serve should hold for the previews", () => {
  const preview: ServerPreview = {
    mode: "tailnet",
    hostname: "mend-preview.tailc79e49.ts.net",
    ports: [20001, 20002, 20003, 20004],
  };

  it("serves again a port whose route reaches anything but the gateway's plain http root over an https listener", () => {
    const lines = tailnetServeLines(preview, preview, [
      route(20001, "http://127.0.0.1:3130/"),
      route(20002, "https://127.0.0.1:3130/"),
      route(20003, "http://127.0.0.1:3130/wrong"),
      route(20004, "http://127.0.0.1:3130/", "http"),
    ]);
    expect(lines.filter((line) => line.includes("tailscale serve --service"))).toEqual(
      [20002, 20003, 20004].map(
        (port) =>
          `  tailscale serve --service=svc:mend-preview --https=${port} --yes http://127.0.0.1:3130`,
      ),
    );
  });

  it("says every port reaches the gateway only when each does, whole", () => {
    expect(
      tailnetServeLines(
        preview,
        preview,
        preview.ports.map((port) => route(port, "http://127.0.0.1:3130/")),
      ),
    ).toEqual([
      "Observed: tailscale serve on this machine serves svc:mend-preview on 20001-20004, every preview port, to the gateway.",
    ]);
  });
});
