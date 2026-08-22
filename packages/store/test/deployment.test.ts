import { describe, expect, it } from "vitest";

import { DeploymentConfigError, resolveDeploymentConfig } from "../src/deployment.ts";

describe("resolveDeploymentConfig", () => {
  it("defaults to local with no endpoint", () => {
    expect(resolveDeploymentConfig({})).toEqual({ mode: "local", sessionEndpoint: undefined });
    expect(resolveDeploymentConfig({ MEND_DEPLOYMENT_MODE: "local" }).mode).toBe("local");
  });

  it("accepts an optional endpoint in local mode", () => {
    expect(
      resolveDeploymentConfig({
        MEND_SESSION_ENDPOINT_LISTEN: "0.0.0.0:3106",
        MEND_SESSION_ENDPOINT_URL: "http://mend-session.mend.svc:3106/",
      }),
    ).toEqual({
      mode: "local",
      sessionEndpoint: { listen: "0.0.0.0:3106", url: "http://mend-session.mend.svc:3106" },
    });
  });

  it("requires the endpoint in kubernetes mode and validates its pieces", () => {
    expect(() => resolveDeploymentConfig({ MEND_DEPLOYMENT_MODE: "kubernetes" })).toThrow(
      DeploymentConfigError,
    );
    expect(() =>
      resolveDeploymentConfig({
        MEND_DEPLOYMENT_MODE: "kubernetes",
        MEND_SESSION_ENDPOINT_LISTEN: "nope",
      }),
    ).toThrow(/host:port/);
    expect(() =>
      resolveDeploymentConfig({
        MEND_DEPLOYMENT_MODE: "kubernetes",
        MEND_SESSION_ENDPOINT_LISTEN: "0.0.0.0:3106",
      }),
    ).toThrow(/MEND_SESSION_ENDPOINT_URL/);
    expect(() =>
      resolveDeploymentConfig({
        MEND_DEPLOYMENT_MODE: "kubernetes",
        MEND_SESSION_ENDPOINT_LISTEN: "0.0.0.0:3106",
        MEND_SESSION_ENDPOINT_URL: "ftp://x",
      }),
    ).toThrow(/http/);
    expect(() => resolveDeploymentConfig({ MEND_DEPLOYMENT_MODE: "cloud" })).toThrow(/local/);
  });

  it("requires TLS cert and key together and https when set", () => {
    const base = {
      MEND_SESSION_ENDPOINT_LISTEN: "0.0.0.0:3106",
      MEND_SESSION_ENDPOINT_URL: "https://mend:3106",
    };
    expect(() =>
      resolveDeploymentConfig({ ...base, MEND_SESSION_ENDPOINT_TLS_CERT: "/c" }),
    ).toThrow(/together/);
    expect(() =>
      resolveDeploymentConfig({
        ...base,
        MEND_SESSION_ENDPOINT_URL: "http://mend:3106",
        MEND_SESSION_ENDPOINT_TLS_CERT: "/c",
        MEND_SESSION_ENDPOINT_TLS_KEY: "/k",
      }),
    ).toThrow(/https/);
    expect(
      resolveDeploymentConfig({
        ...base,
        MEND_SESSION_ENDPOINT_TLS_CERT: "/c",
        MEND_SESSION_ENDPOINT_TLS_KEY: "/k",
      }).sessionEndpoint?.tls,
    ).toEqual({ certPath: "/c", keyPath: "/k" });
  });
});
