import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { isIP, type LookupFunction } from "node:net";

import { ImageDigest, imageDigestOf, parseImageReference } from "@mend/domain/workbench";
import { classifyAddress } from "@mend/store";
import { Config, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

/**
 * Pins a resource's image at approval (ADR 0019, "Approving a definition"): the digest of the
 * manifest a registry serves for its tag, through the OCI distribution API. Mend asks the
 * operator's Docker Hub mirrors first, then the registry. Only an operator's mirror may be private
 * or plain HTTP; any other destination, a redirect's or a token realm's included, must be HTTPS on
 * a public address, checked on the address the connection dials. No credential is sent but the
 * anonymous token a registry hands out, and only back to that registry's origin.
 */

const FAILURE_WORDS = {
  "not-found": "not found in the registry",
  "login-required": "registry needs a login · ask the operator",
  "registry-refused": "registry is not allowed on this instance",
  unavailable: "registry did not answer · try approval again",
  unverifiable: "registry returned an unverifiable manifest",
} as const;
type ImageFailure = keyof typeof FAILURE_WORDS;

const isFailure = (answer: string): answer is ImageFailure => Object.hasOwn(FAILURE_WORDS, answer);

export class ImageResolutionError extends Schema.TaggedError<ImageResolutionError>()(
  "ImageResolutionError",
  {
    image: Schema.String,
    reason: Schema.Literals([
      "not-found",
      "login-required",
      "registry-refused",
      "unavailable",
      "unverifiable",
    ]),
  },
) {}

/** `@db · image postgres:17 · not found in the registry · not approved`. */
export const imageRefusalLine = (name: string, error: ImageResolutionError): string =>
  `@${name} · image ${error.image} · ${FAILURE_WORDS[error.reason]} · not approved`;

export interface ResolvedImage {
  readonly digest: ImageDigest;
  /** The mirror or registry host that answered; null when nothing was asked. */
  readonly resolvedBy: string | null;
}

export class ResourceImageResolver extends Context.Service<
  ResourceImageResolver,
  {
    /** An image pinned `@sha256:` already is its own digest, and nothing is asked. */
    readonly resolve: (image: string) => Effect.Effect<ResolvedImage, ImageResolutionError>;
  }
>()("@mend/sessions/ResourceImageResolver") {}

export interface RegistryAccess {
  /** Docker Hub's mirrors, which the operator runs, asked in order before Docker Hub itself. */
  readonly mirrors: ReadonlyArray<URL>;
  /** Every address a host name resolves to; a connection dials one of these and no other. */
  readonly resolve: (host: string) => Promise<ReadonlyArray<string>>;
  /** Whether an address is on the public internet; only an operator's mirror may dial another. */
  readonly isPublic: (address: string) => boolean;
  /** For the whole resolution: every mirror, the token and the registry. */
  readonly deadlineMs: number;
  readonly maxManifestBytes: number;
}

const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
];
const MAX_TOKEN_BYTES = 64 * 1024;
const MAX_REDIRECTS = 3;
const DOCKER_HUB = "https://registry-1.docker.io";

interface Reference {
  readonly hub: boolean;
  readonly origin: string;
  readonly repository: string;
  readonly tag: string;
}

/** `postgres:17` is Docker Hub's `library/postgres` at `17`; a reference with no tag is `latest`. */
const referenceOf = (image: string): Reference | null => {
  const { host, repository, tag, digest } = parseImageReference(image);
  if (digest !== null) return null;
  const hub = host === null || host === "docker.io" || host === "index.docker.io";
  return {
    hub,
    origin: hub ? DOCKER_HUB : `https://${host}`,
    repository: hub && !repository.includes("/") ? `library/${repository}` : repository,
    tag: tag ?? "latest",
  };
};

class Refused extends Error {}

interface Reply {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  /** Null when the body is over its limit. */
  readonly body: Buffer | null;
}

const header = (headers: http.IncomingHttpHeaders, name: string): string | undefined => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/** `Bearer realm="…",service="…"`, the challenge a registry answers an anonymous pull with. */
const bearerChallenge = (value: string | undefined) => {
  if (value === undefined || !/^bearer\s/i.test(value)) return null;
  const params = new Map(
    [...value.matchAll(/(\w+)="([^"]*)"/g)].map(([, key = "", field = ""]) => [
      key.toLowerCase(),
      field,
    ]),
  );
  const realm = params.get("realm");
  return realm === undefined ? null : { realm, service: params.get("service") ?? null };
};

const makeResolve = (access: RegistryAccess) => {
  const operatorOrigins = new Set(access.mirrors.map((mirror) => mirror.origin));

  /** One GET. The address it dials is the one checked here, so DNS cannot answer differently. */
  const get = async (
    url: URL,
    headers: Readonly<Record<string, string>>,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Reply> => {
    const operator = operatorOrigins.has(url.origin);
    if (!operator && url.protocol !== "https:") throw new Refused("not https");
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Refused("not http");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host) === 0 ? await access.resolve(host) : [host];
    const [address] = addresses;
    if (address === undefined) throw new Error(`${host} does not resolve`);
    if (!operator && !addresses.every((each) => access.isPublic(each))) {
      throw new Refused(`${host} is not a public address`);
    }
    const lookup: LookupFunction = (_name, options, callback) => {
      const family = isIP(address);
      if (options.all === true) callback(null, [{ address, family }]);
      else callback(null, address, family);
    };
    const client = url.protocol === "https:" ? https : http;
    return new Promise<Reply>((resolve, reject) => {
      const request = client.get(url, { headers, lookup, signal, agent: false }, (response) => {
        const chunks: Array<Buffer> = [];
        let size = 0;
        const done = (body: Buffer | null) =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body });
        if (Number(header(response.headers, "content-length") ?? 0) > maxBytes) {
          response.destroy();
          return done(null);
        }
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy();
            done(null);
          } else chunks.push(chunk);
        });
        response.on("end", () => done(Buffer.concat(chunks)));
        response.on("error", reject);
      });
      request.on("error", reject);
    });
  };

  /** The anonymous pull token a challenge names; the realm is checked as any destination is. */
  const tokenFor = async (
    challenge: { readonly realm: string; readonly service: string | null },
    repository: string,
    signal: AbortSignal,
  ): Promise<string | ImageFailure> => {
    const realm = new URL(challenge.realm);
    if (challenge.service !== null) realm.searchParams.set("service", challenge.service);
    realm.searchParams.set("scope", `repository:${repository}:pull`);
    const reply = await get(realm, { accept: "application/json" }, MAX_TOKEN_BYTES, signal);
    if (reply.status === 429 || reply.status >= 500) return "unavailable";
    if (reply.status !== 200 || reply.body === null) return "login-required";
    let parsed: unknown;
    try {
      parsed = JSON.parse(reply.body.toString("utf8"));
    } catch {
      return "login-required";
    }
    const token =
      typeof parsed === "object" && parsed !== null
        ? (Reflect.get(parsed, "token") ?? Reflect.get(parsed, "access_token"))
        : undefined;
    return typeof token === "string" && token !== "" ? token : "login-required";
  };

  /** The digest of the bytes served, when the reply says the same and is a manifest or index. */
  const verified = (reply: Reply): ImageDigest | ImageFailure => {
    const type = (header(reply.headers, "content-type") ?? "").split(";")[0]?.trim() ?? "";
    if (reply.body === null || !MANIFEST_TYPES.includes(type)) return "unverifiable";
    const digest = `sha256:${createHash("sha256").update(reply.body).digest("hex")}`;
    const claimed = header(reply.headers, "docker-content-digest");
    if (claimed !== undefined && claimed !== digest) return "unverifiable";
    let manifest: unknown;
    try {
      manifest = JSON.parse(reply.body.toString("utf8"));
    } catch {
      return "unverifiable";
    }
    if (typeof manifest !== "object" || manifest === null) return "unverifiable";
    const mediaType: unknown = Reflect.get(manifest, "mediaType");
    if (Reflect.get(manifest, "schemaVersion") !== 2) return "unverifiable";
    if (mediaType !== undefined && mediaType !== type) return "unverifiable";
    return Schema.is(ImageDigest)(digest) ? digest : "unverifiable";
  };

  /** One registry's answer for the reference, following its redirects and one token challenge. */
  const manifestAt = async (
    base: string,
    reference: Reference,
    signal: AbortSignal,
  ): Promise<ImageDigest | ImageFailure> => {
    let url = new URL(`/v2/${reference.repository}/manifests/${reference.tag}`, base);
    let token: { readonly origin: string; readonly value: string } | null = null;
    let challenged = false;
    for (let redirects = 0; ; ) {
      const authorization =
        token !== null && token.origin === url.origin
          ? { authorization: `Bearer ${token.value}` }
          : {};
      const reply = await get(
        url,
        { accept: MANIFEST_TYPES.join(", "), ...authorization },
        access.maxManifestBytes,
        signal,
      );
      const location = header(reply.headers, "location");
      if (reply.status >= 300 && reply.status < 400 && location !== undefined) {
        redirects += 1;
        if (redirects > MAX_REDIRECTS) return "unverifiable";
        url = new URL(location, url);
        continue;
      }
      if (reply.status === 401 && !challenged) {
        challenged = true;
        const challenge = bearerChallenge(header(reply.headers, "www-authenticate"));
        if (challenge === null) return "login-required";
        const issued = await tokenFor(challenge, reference.repository, signal);
        if (issued === "unavailable" || issued === "login-required") return issued;
        token = { origin: url.origin, value: issued };
        continue;
      }
      if (reply.status === 401 || reply.status === 403) return "login-required";
      if (reply.status === 404) return "not-found";
      if (reply.status === 429 || reply.status >= 500) return "unavailable";
      return reply.status === 200 ? verified(reply) : "unverifiable";
    }
  };

  return async (
    reference: Reference,
    signal: AbortSignal,
  ): Promise<ResolvedImage | ImageFailure> => {
    const bases = reference.hub
      ? [...access.mirrors.map((mirror) => mirror.origin), reference.origin]
      : [reference.origin];
    let failure: ImageFailure = "unavailable";
    // A mirror that does not answer hands over to the next, then to the registry; any other
    // answer is final, since a pull-through mirror says what the registry would.
    for (const base of bases) {
      const answer = await manifestAt(base, reference, signal).catch(
        (cause: unknown): ImageFailure =>
          cause instanceof Refused ? "registry-refused" : "unavailable",
      );
      if (!isFailure(answer)) return { digest: answer, resolvedBy: new URL(base).host };
      failure = answer;
      if (failure !== "unavailable") break;
    }
    return failure;
  };
};

/** The resolver over `access`; tests hand it a local registry and their own name resolution. */
export const resourceImageResolverWith = (
  access: RegistryAccess,
): Layer.Layer<ResourceImageResolver> =>
  Layer.sync(ResourceImageResolver, () => {
    const resolveAll = makeResolve(access);
    return {
      resolve: Effect.fn("ResourceImageResolver.resolve")(function* (image: string) {
        const fail = (reason: ImageFailure) => new ImageResolutionError({ image, reason });
        const pinned = imageDigestOf(image);
        if (pinned !== null) return { digest: pinned, resolvedBy: null };
        const reference = referenceOf(image);
        // Pinned by a digest Mend does not verify (`@sha512:…`).
        if (reference === null) return yield* fail("unverifiable");
        const answer = yield* Effect.tryPromise({
          try: (signal) => resolveAll(reference, signal),
          catch: () => fail("unavailable"),
        }).pipe(
          Effect.timeoutOrElse({
            duration: access.deadlineMs,
            orElse: () => Effect.fail(fail("unavailable")),
          }),
        );
        return typeof answer === "string" ? yield* fail(answer) : answer;
      }),
    };
  });

/** Mirrors as `compose.mirrors.yaml` names them: comma-separated origins, none with credentials. */
const mirrorsOf = (value: string): ReadonlyArray<URL> =>
  value.split(",").flatMap((entry) => {
    try {
      const url = new URL(entry.trim());
      const plain = url.username === "" && url.password === "";
      return plain && (url.protocol === "http:" || url.protocol === "https:") ? [url] : [];
    } catch {
      return [];
    }
  });

export const ResourceImageResolverLive: Layer.Layer<ResourceImageResolver, Config.ConfigError> =
  Layer.unwrap(
    Effect.gen(function* () {
      const mirrors = yield* Config.String("SEALANT_DOCKER_REGISTRY_MIRRORS").pipe(
        Config.withDefault(""),
      );
      return resourceImageResolverWith({
        mirrors: mirrorsOf(mirrors),
        resolve: async (host) =>
          (await dnsLookup(host, { all: true, verbatim: true })).map((each) => each.address),
        isPublic: (address) => classifyAddress(address) === "public",
        deadlineMs: 15_000,
        maxManifestBytes: 4 * 1024 * 1024,
      });
    }),
  );
