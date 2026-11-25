import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  BlobStorePresignEndpoint,
  makeS3BlobStore,
  presignedObjectOrigin,
  type PresignEndpoint,
} from "../src/blob-store.ts";

/**
 * What the capture relay expects of a presigned URL's host (`presignedObjectOrigin`) against the
 * host of a URL Mend's own S3 store presigns, with no request sent: the two must agree for every
 * shape of store, or `capture.sock` refuses the executor's object requests.
 */

const credentials = { accessKeyId: "test", secretAccessKey: "test" };

const presignedHost = (
  options: {
    readonly bucket: string;
    readonly endpoint?: string;
    readonly region: string;
    readonly forcePathStyle: boolean;
    readonly publicEndpoint?: string;
  },
  audience: PresignEndpoint = "public",
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* makeS3BlobStore({ ...options, credentials });
      const url = new URL(yield* store.presign("captures/abc", "PUT", 300, 2));
      return { hostname: url.hostname, port: url.port, protocol: url.protocol };
    }).pipe(Effect.provideService(BlobStorePresignEndpoint, audience)),
  );

const expected = (
  options: {
    readonly bucket: string;
    readonly endpoint?: string;
    readonly region: string;
    readonly forcePathStyle: boolean;
    readonly publicEndpoint?: string;
  },
  audience: PresignEndpoint = "public",
) =>
  Effect.runPromise(
    presignedObjectOrigin(
      {
        target: {
          kind: "s3",
          bucket: options.bucket,
          endpoint: options.endpoint,
          region: options.region,
          forcePathStyle: options.forcePathStyle,
        },
        publicUrl: options.publicEndpoint,
      },
      audience,
    ),
  );

describe("the origin of a presigned object URL", () => {
  const cases = [
    {
      name: "an AWS bucket, virtual-hosted",
      store: { bucket: "mend-captures", region: "eu-west-1", forcePathStyle: false },
      host: "mend-captures.s3.eu-west-1.amazonaws.com",
    },
    {
      name: "a dotted AWS bucket, which the SDK presigns path-style",
      store: { bucket: "mend.captures", region: "eu-west-1", forcePathStyle: false },
      host: "s3.eu-west-1.amazonaws.com",
    },
    {
      name: "a custom endpoint with path style",
      store: {
        bucket: "mend",
        endpoint: "https://minio.example.com",
        region: "us-east-1",
        forcePathStyle: true,
      },
      host: "minio.example.com",
    },
    {
      name: "a custom endpoint without path style, as <bucket>.<endpoint>",
      store: {
        bucket: "mend",
        endpoint: "https://minio.example.com",
        region: "us-east-1",
        forcePathStyle: false,
      },
      host: "mend.minio.example.com",
    },
    {
      name: "Garage behind its public URL",
      store: {
        bucket: "mend",
        endpoint: "http://garage:3900",
        region: "garage",
        forcePathStyle: true,
        publicEndpoint: "http://garage:3900",
      },
      host: "garage",
    },
  ] as const;

  for (const entry of cases) {
    it(`agrees with Mend's presigner for ${entry.name}`, async () => {
      const presigned = await presignedHost(entry.store);
      const origin = await expected(entry.store);
      expect(presigned.hostname).toBe(entry.host);
      expect(origin?.hostname).toBe(presigned.hostname);
      expect(`${origin?.protocol}:`).toBe(presigned.protocol);
    });
  }

  it("uses the internal endpoint for internal presigning while keeping publicUrl for public presigning", async () => {
    const store = {
      bucket: "mend",
      endpoint: "http://garage:3900",
      region: "garage",
      forcePathStyle: true,
      publicEndpoint: "https://remote.example.ts.net:10000",
    };

    const pub = await presignedHost(store, "public");
    const pubOrigin = await expected(store, "public");
    expect(pub).toEqual({ hostname: "remote.example.ts.net", port: "10000", protocol: "https:" });
    expect(pubOrigin).toEqual({
      hostname: "remote.example.ts.net",
      port: 10000,
      protocol: "https",
    });

    const internal = await presignedHost(store, "internal");
    const internalOrigin = await expected(store, "internal");
    expect(internal).toEqual({ hostname: "garage", port: "3900", protocol: "http:" });
    expect(internalOrigin).toEqual({ hostname: "garage", port: 3900, protocol: "http" });

    const [getUrl, partUrl] = await Effect.runPromise(
      Effect.gen(function* () {
        const s3 = yield* makeS3BlobStore({ ...store, credentials });
        const get = new URL(yield* s3.presign("captures/abc", "GET", 300));
        const part = new URL(yield* s3.presignPart("captures/abc", "upload-1", 1, 300, 1024));
        return [get, part] as const;
      }).pipe(Effect.provideService(BlobStorePresignEndpoint, "internal")),
    );
    expect(getUrl.origin).toBe("http://garage:3900");
    expect(partUrl.origin).toBe("http://garage:3900");
  });
});
