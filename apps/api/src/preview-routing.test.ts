import { encodePreviewLabel, PreviewId, PreviewLabel } from "@mend/domain";
import { Redacted } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  appCookieHeader,
  appSetCookie,
  cookieNamespaceOf,
  type CookiePolicy,
  cookiePolicyOf,
  grantCookieOf,
  isGrantCookieName,
  namespacedCookieName,
  previewAtOrigin,
  previewOriginOf,
  type PreviewRouting,
  reachedPreviewOrigin,
  readGrantCookie,
  setGrantCookie,
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
const HOSTED: CookiePolicy = { mode: "host-per-preview" };
const OWN_PORT: CookiePolicy = { mode: "tailnet-ports", label: LABEL };

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
    for (const policy of [HOSTED, OWN_PORT]) {
      expect(
        appCookieHeader(
          [
            "theme=dark; __Host-mend-preview=g1; mend-preview=g2",
            "__Host-mend-preview-443=g3; __Host-mend-preview-20001=g4; next-auth.session-token=s",
          ],
          policy,
        ),
      ).toBe("theme=dark; next-auth.session-token=s");
      expect(appCookieHeader(["__Host-mend-preview-443=g3"], policy)).toBeNull();
    }
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

const jarAfter = (setCookies: ReadonlyArray<string>, now: number) => {
  const jar = new Map<string, string>();
  for (const line of setCookies) {
    const [pair = "", ...attributes] = line.split(";").map((part) => part.trim());
    const name = pair.slice(0, pair.indexOf("="));
    const expired = attributes.some((attribute) => {
      const [key = "", value = ""] = attribute.split("=");
      const field = key.trim().toLowerCase();
      if (field === "max-age") return Number(value) <= 0;
      return field === "expires" && Date.parse(value) <= now;
    });
    if (expired) jar.delete(name);
    else jar.set(name, pair);
  }
  return [...jar.values()].join("; ");
};

describe("application cookies through the gateway", () => {
  const own = (name: string) => namespacedCookieName(LABEL, name);
  const other = (name: string) => namespacedCookieName(OTHER.label, name);

  it("are namespaced only where previews share a host", () => {
    expect(cookiePolicyOf(tailnet, PREVIEW)).toEqual(OWN_PORT);
    expect(cookiePolicyOf(domain, PREVIEW)).toEqual(HOSTED);
    expect(cookiePolicyOf(loopback, PREVIEW)).toEqual(HOSTED);
  });

  it.each([
    ["sid", `p-${LABEL}.sid`],
    ["__Host-sid", `__Host-p-${LABEL}.sid`],
    ["__Secure-sid", `__Secure-p-${LABEL}.sid`],
    ["__host-sid", `__host-p-${LABEL}.sid`],
  ])("keep a security prefix first: %s is sent as %s", (name, wire) => {
    expect(own(name)).toBe(wire);
  });

  const labels = fc.uint8Array({ minLength: 16, maxLength: 16 }).map(encodePreviewLabel);
  const tokens = fc.stringMatching(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,40}$/);
  const names = fc.oneof(
    tokens,
    tokens.map((name) => `__Host-${name}`),
    tokens.map((name) => `__Secure-${name}`),
    fc.tuple(labels, tokens).map(([label, name]) => namespacedCookieName(label, name)),
  );

  it("read back under their own preview, and never under another", () => {
    fc.assert(
      fc.property(labels, labels, names, (label, stranger, name) => {
        const wire = namespacedCookieName(label, name);
        expect(cookieNamespaceOf(label, wire)).toEqual({ _tag: "Own", name });
        if (stranger !== label)
          expect(cookieNamespaceOf(stranger, wire)).toEqual({ _tag: "Foreign" });
      }),
    );
  });

  it("set as HttpOnly by the application come back to it under their own names", () => {
    fc.assert(
      fc.property(labels, tokens, tokens, (label, name, value) => {
        const policy: CookiePolicy = { mode: "tailnet-ports", label };
        const [stored] = appSetCookie(`${name}=${value}; Path=/; HttpOnly`, policy);
        if (stored === undefined) return;
        const sent = stored.slice(0, stored.indexOf(";"));
        expect(sent.startsWith(`p-${label}.`)).toBe(true);
        expect(appCookieHeader([sent], policy)).toBe(`${name}=${value}`);
        expect(appCookieHeader([sent], { mode: "tailnet-ports", label: OTHER.label })).toBeNull();
      }),
    );
  });

  it.each([
    ["this preview's cookie loses its namespace", [`${own("sid")}=1`], "sid=1"],
    ["another preview's cookie is dropped", [`${other("sid")}=1; theme=dark`], "theme=dark"],
    ["a script cookie passes", ["theme=dark", "csrf=t"], "theme=dark; csrf=t"],
    ["a namespace with a malformed label is a plain name", ["p-short.sid=1"], "p-short.sid=1"],
    [
      "a namespaced grant is dropped",
      [`${own("__Host-mend-preview-443")}=g; ${own("mend-preview")}=g`],
      null,
    ],
    [
      "an app's better-auth cookie, plain or namespaced, passes as the app's",
      [
        "better-auth.session_token=s; __Secure-better-auth.session_data.0=d",
        `${own("better-auth.session_token")}=s; ${own("__Secure-better-auth.dont_remember")}=r`,
      ],
      "better-auth.session_token=s; __Secure-better-auth.session_data.0=d; better-auth.session_token=s; __Secure-better-auth.dont_remember=r",
    ],
  ])("on a tailnet, %s", (_, headers, expected) => {
    expect(appCookieHeader(headers, OWN_PORT)).toBe(expected);
  });

  it("on a host per preview pass apart from grants", () => {
    expect(
      appCookieHeader(
        [`${other("sid")}=1; better-auth.session_token=s; theme=dark`, "__Host-mend-preview=g"],
        HOSTED,
      ),
    ).toBe(`${other("sid")}=1; better-auth.session_token=s; theme=dark`);
  });

  const EXPIRES = "Expires=Wed, 21 Oct 2026 07:28:00 GMT";

  it.each<readonly [string, string, CookiePolicy, string | null]>([
    [
      "every Domain attribute is removed",
      `sid=1; Domain=ts.net; Path=/; domain=.example; ${EXPIRES}`,
      HOSTED,
      `sid=1; Path=/; ${EXPIRES}`,
    ],
    [
      "an HttpOnly cookie is renamed into this preview's namespace",
      `sid=a=b; Path=/; HttpOnly; Secure; ${EXPIRES}`,
      OWN_PORT,
      `${own("sid")}=a=b; Path=/; HttpOnly; Secure; ${EXPIRES}`,
    ],
    [
      "an HttpOnly __Host- cookie keeps its prefix first",
      "__Host-sid=1; Path=/; Secure; httponly",
      OWN_PORT,
      `__Host-p-${LABEL}.sid=1; Path=/; Secure; httponly`,
    ],
    ["a script cookie keeps its name", "csrf=t; Path=/", OWN_PORT, "csrf=t; Path=/"],
    [
      "a script cookie named like a namespace is dropped",
      `${other("sid")}=1; Path=/`,
      OWN_PORT,
      null,
    ],
    ["a grant name is dropped", "__Host-mend-preview-443=x; HttpOnly", OWN_PORT, null],
    ["a grant name is dropped on a host", "__Host-mend-preview=x; HttpOnly", HOSTED, null],
    [
      "an app's better-auth cookie passes",
      "better-auth.session_token=x; HttpOnly",
      HOSTED,
      "better-auth.session_token=x; HttpOnly",
    ],
    ["a nameless cookie is dropped", "abc; Path=/", HOSTED, null],
    ["an empty name is dropped", "=abc; Path=/", HOSTED, null],
  ])("Set-Cookie: %s", (_, raw, policy, expected) => {
    expect(appSetCookie(raw, policy)).toEqual(expected === null ? [] : [expected]);
  });

  it.each([
    ["Max-Age=0", "session=; Path=/; Max-Age=0"],
    ["Expires in the past", "session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT"],
  ])(
    "on a tailnet, an app's logout clears its HttpOnly cookie with %s and no HttpOnly",
    (_, clear) => {
      const set = appSetCookie("session=secret; Path=/; HttpOnly; Secure", OWN_PORT);
      const cleared = appSetCookie(clear, OWN_PORT);
      const next = appCookieHeader([jarAfter([...set, ...cleared], Date.now())], OWN_PORT);
      expect(next, "the next request carries no session").toBeNull();
    },
  );
});
