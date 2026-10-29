import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hasOpenssl, makeCertificate } from "../test-fixtures/preview-certificate.ts";
import {
  checkPreviewCertificate,
  parsePreviewFile,
  previewDomainProblem,
} from "./server-preview.ts";

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
    expect(previewDomainProblem(domain, mend)).toContain(words);
  });

  it("takes a sibling on Mend's own site", () => {
    expect(previewDomainProblem("previews.example.com", mend)).toBeNull();
  });

  it("takes a registrable domain of its own", () => {
    expect(previewDomainProblem("previews.example.net", mend)).toBeNull();
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
