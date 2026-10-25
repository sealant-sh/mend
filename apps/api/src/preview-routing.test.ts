import { PreviewId, PreviewLabel } from "@mend/domain";
import { Redacted } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  grantCookieOf,
  isGrantCookieName,
  previewAtOrigin,
  previewOriginOf,
  type PreviewRouting,
  reachedPreviewOrigin,
  readGrantCookie,
  setGrantCookie,
  withoutGrantCookies,
} from "./preview-routing.ts";

const LABEL = PreviewLabel.make("aaaaaaaaaaaaaaaaaaaaaaaaaa");
const PREVIEW = { id: PreviewId.make("pv-1"), label: LABEL };
const OTHER = {
  id: PreviewId.make("pv-2"),
  label: PreviewLabel.make("baaaaaaaaaaaaaaaaaaaaaaaaa"),
};
const domain: PreviewRouting = { mode: "domain-https", domain: "preview.example", port: 443 };
const loopback: PreviewRouting = { mode: "loopback-http", port: 3110 };
const tailnet: PreviewRouting = {
  mode: "tailnet-https",
  hostname: "mend-preview.tail1234.ts.net",
  ports: [
    { port: 443, previewId: PREVIEW.id },
    { port: 20001, previewId: OTHER.id },
  ],
};
const GRANT = Redacted.make(`mpg_${"a".repeat(43)}`);

const originOf = (routing: PreviewRouting, preview = PREVIEW) => {
  const origin = previewOriginOf(routing, preview);
  if (origin === null) throw new Error("the routing assigns this preview an origin");
  return origin;
};

const readTailnetGrant = (headers: ReadonlyArray<string>) => {
  const grant = readGrantCookie(headers, "__Host-mend-preview-20001");
  return grant === null || grant === "repeated" ? grant : Redacted.value(grant);
};

describe("preview hosts and their origins", () => {
  it("addresses a preview by label on a domain and on loopback, by port on a tailnet", () => {
    expect(originOf(domain)).toBe(`https://${LABEL}.preview.example`);
    expect(originOf({ ...domain, port: 8443 })).toBe(`https://${LABEL}.preview.example:8443`);
    expect(originOf(loopback)).toBe(`http://${LABEL}.localhost:3110`);
    expect(originOf(tailnet)).toBe("https://mend-preview.tail1234.ts.net");
    expect(originOf(tailnet, OTHER)).toBe("https://mend-preview.tail1234.ts.net:20001");
    expect(
      previewOriginOf(tailnet, { id: PreviewId.make("pv-unassigned"), label: LABEL }),
    ).toBeNull();
  });

  it("reads back exactly the preview an origin names, and nothing for any other host", () => {
    expect(previewAtOrigin(domain, originOf(domain))).toEqual({ label: LABEL });
    expect(previewAtOrigin(loopback, originOf(loopback))).toEqual({ label: LABEL });
    expect(previewAtOrigin(tailnet, originOf(tailnet, OTHER))).toEqual({ previewId: OTHER.id });
    for (const authority of [
      `${LABEL}.preview.example:8443`,
      `x.${LABEL}.preview.example`,
      `${LABEL}.preview.example.evil`,
      "preview.example",
      `${LABEL}x.preview.example`,
      `user@${LABEL}.preview.example`,
      `${LABEL}.preview.example/path`,
      "",
    ]) {
      expect(reachedPreviewOrigin(domain, authority)).toBeNull();
    }
    expect(reachedPreviewOrigin(domain, `${LABEL.toUpperCase()}.Preview.Example`)).toBe(
      originOf(domain),
    );
    expect(reachedPreviewOrigin(domain, `${LABEL}.preview.example:443`)).toBe(originOf(domain));
    expect(reachedPreviewOrigin(tailnet, "mend-preview.tail1234.ts.net:20002")).toBeNull();
    expect(reachedPreviewOrigin(tailnet, "mend-preview.tail1234.ts.net:20001")).toBe(
      originOf(tailnet, OTHER),
    );
    expect(reachedPreviewOrigin(loopback, `${LABEL}.localhost:3111`)).toBeNull();
  });
});

describe("the grant cookie", () => {
  it("is __Host- and Secure over https, per port on a tailnet, and plain on loopback http", () => {
    expect(setGrantCookie(grantCookieOf(domain, originOf(domain)), GRANT)).toBe(
      `__Host-mend-preview=${Redacted.value(GRANT)}; Path=/; HttpOnly; SameSite=Lax; Secure`,
    );
    expect(grantCookieOf(tailnet, originOf(tailnet)).name).toBe("__Host-mend-preview-443");
    expect(grantCookieOf(tailnet, originOf(tailnet, OTHER))).toEqual({
      name: "__Host-mend-preview-20001",
      secure: true,
    });
    expect(setGrantCookie(grantCookieOf(loopback, originOf(loopback)), GRANT)).toBe(
      `mend-preview=${Redacted.value(GRANT)}; Path=/; HttpOnly; SameSite=Lax`,
    );
  });

  it("never names a Domain, an expiry or a lifetime of its own", () => {
    for (const routing of [domain, loopback, tailnet]) {
      const header = setGrantCookie(grantCookieOf(routing, originOf(routing)), GRANT);
      expect(header).not.toMatch(/domain=|expires=|max-age=/i);
    }
  });

  it("is read once by its own name; a repeat is refused and a stranger's shape ignored", () => {
    const value = Redacted.value(GRANT);
    expect(
      readTailnetGrant([`a=1; __Host-mend-preview-20001=${value}; __Host-mend-preview-443=x`]),
    ).toBe(value);
    expect(
      readTailnetGrant([
        `__Host-mend-preview-20001=${value}`,
        `__Host-mend-preview-20001=${value}`,
      ]),
    ).toBe("repeated");
    expect(readTailnetGrant([`__Host-mend-preview-443=${value}`])).toBeNull();
    expect(readTailnetGrant(["__Host-mend-preview-20001=not-a-grant"])).toBeNull();
  });

  it("is stripped in every routing's and every port's name, and app cookies are kept", () => {
    expect(
      withoutGrantCookies([
        "theme=dark; __Host-mend-preview=g1; mend-preview=g2",
        "__Host-mend-preview-443=g3; __Host-mend-preview-20001=g4; next-auth.session-token=s",
      ]),
    ).toBe("theme=dark; next-auth.session-token=s");
    expect(withoutGrantCookies(["__Host-mend-preview-443=g3"])).toBeNull();
    for (const name of ["__Host-mend-preview", "__Host-mend-preview-8443", "mend-preview"]) {
      expect(isGrantCookieName(name)).toBe(true);
    }
    for (const name of ["__Host-mend-preview-", "mend-preview-1", "__Secure-mend-preview", "x"]) {
      expect(isGrantCookieName(name)).toBe(false);
    }
  });
});

describe("preview origins in the browser's own form", () => {
  const routings: ReadonlyArray<readonly [string, PreviewRouting]> = [
    ["loopback on port 80", { mode: "loopback-http", port: 80 }],
    ["loopback on 3110", loopback],
    ["a domain on 443", domain],
    ["a domain on 8443", { ...domain, port: 8443 }],
    ["an upper-case domain", { mode: "domain-https", domain: "Preview.EXAMPLE", port: 443 }],
    ["a tailnet on 443", tailnet],
    [
      "an upper-case tailnet name",
      { ...tailnet, hostname: "Mend-Preview.TAIL1234.ts.net" } satisfies PreviewRouting,
    ],
  ];

  it.each(routings)("%s: the origin built is the one a browser sends and reaches", (_, routing) => {
    for (const preview of [PREVIEW, OTHER]) {
      const origin = originOf(routing, preview);
      expect(new URL(origin).origin).toBe(origin);
      const host = new URL(origin).host;
      for (const authority of [host, host.toUpperCase()]) {
        expect(reachedPreviewOrigin(routing, authority), authority).toBe(origin);
      }
      expect(previewAtOrigin(routing, origin)).toEqual(
        routing.mode === "tailnet-https" ? { previewId: preview.id } : { label: preview.label },
      );
    }
  });

  it("elides only the scheme's own default port", () => {
    expect(originOf({ mode: "loopback-http", port: 80 })).toBe(`http://${LABEL}.localhost`);
    expect(reachedPreviewOrigin({ mode: "loopback-http", port: 80 }, `${LABEL}.localhost:80`)).toBe(
      `http://${LABEL}.localhost`,
    );
    expect(originOf({ mode: "loopback-http", port: 443 })).toBe(`http://${LABEL}.localhost:443`);
    expect(originOf({ ...domain, port: 80 })).toBe(`https://${LABEL}.preview.example:80`);
    expect(originOf({ ...tailnet, ports: [{ port: 443, previewId: PREVIEW.id }] })).toBe(
      "https://mend-preview.tail1234.ts.net",
    );
    expect(reachedPreviewOrigin(domain, `${LABEL}.preview.example:443`)).toBe(originOf(domain));
  });

  it("round-trips every port", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 65535 }), fc.boolean(), (port, secure) => {
        const routing: PreviewRouting = secure
          ? { ...domain, port }
          : { mode: "loopback-http", port };
        const origin = originOf(routing);
        expect(new URL(origin).origin).toBe(origin);
        expect(reachedPreviewOrigin(routing, new URL(origin).host)).toBe(origin);
        expect(reachedPreviewOrigin(routing, `${new URL(origin).hostname}:${port}`)).toBe(origin);
      }),
    );
  });
});
