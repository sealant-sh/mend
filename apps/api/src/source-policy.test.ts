import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { classifyAddress, makeSourcePolicy, type SourceProfile } from "./source-policy.ts";

describe("classifyAddress", () => {
  it("tells public addresses from private, loopback, link-local and metadata ones", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["140.82.112.3", "public"],
      ["10.0.0.5", "private"],
      ["100.100.1.2", "private"],
      ["172.20.0.1", "private"],
      ["192.168.1.20", "private"],
      ["127.0.0.1", "loopback"],
      ["169.254.10.1", "link-local"],
      ["169.254.169.254", "metadata"],
      ["2606:50c0:8000::153", "public"],
      ["::1", "loopback"],
      ["fe80::1", "link-local"],
      ["fd12:3456::1", "private"],
      ["fd00:ec2::254", "metadata"],
      ["::ffff:10.0.0.5", "private"],
      ["::ffff:169.254.169.254", "metadata"],
      ["::", "private"],
    ];
    expect(cases.map(([address]) => [address, classifyAddress(address)])).toEqual(cases);
  });
});

const names: Record<string, ReadonlyArray<string>> = {
  "github.com": ["140.82.112.3"],
  "git.lan": ["10.0.0.5"],
  "rebind.example": ["140.82.112.3", "127.0.0.1"],
};

const policy = (profile: SourceProfile, allowedHosts: ReadonlyArray<string> = []) =>
  makeSourcePolicy({
    profile,
    allowedHosts,
    resolve: async (host) => {
      const answer = names[host];
      if (answer === undefined) throw new Error("no such host");
      return answer;
    },
  });

const outcome = (
  profile: SourceProfile,
  source: string,
  options: { readonly operator?: boolean; readonly allowed?: ReadonlyArray<string> } = {},
) =>
  Effect.runPromise(
    policy(profile, options.allowed)
      .check(source, { isOperator: options.operator ?? false })
      .pipe(
        Effect.exit,
        Effect.map((exit) => (Exit.isSuccess(exit) ? "allowed" : "refused")),
      ),
  );

describe("the source policy", () => {
  it("lets both profiles reach public hosts, and neither the metadata service or local paths", async () => {
    for (const profile of ["operator", "tenant"] as const) {
      expect(await outcome(profile, "git@github.com:acme/api.git")).toBe("allowed");
      expect(
        await outcome(profile, "https://169.254.169.254/latest/x.git", { operator: true }),
      ).toBe("refused");
      expect(
        await outcome(profile, "http://metadata.google.internal/x.git", { operator: true }),
      ).toBe("refused");
      expect(await outcome(profile, "file:///etc/x.git", { operator: true })).toBe("refused");
      expect(await outcome(profile, "/srv/git/api.git", { operator: true })).toBe("refused");
    }
  });

  it("operator profile: private networks for everyone, this machine for the operator only", async () => {
    expect(await outcome("operator", "ssh://git@git.lan/acme/api.git")).toBe("allowed");
    expect(await outcome("operator", "http://localhost/acme/api.git")).toBe("refused");
    expect(await outcome("operator", "http://localhost/acme/api.git", { operator: true })).toBe(
      "allowed",
    );
  });

  it("tenant profile: no private, local or unauthenticated remotes unless a private host is allowed", async () => {
    expect(await outcome("tenant", "ssh://git@git.lan/acme/api.git")).toBe("refused");
    expect(
      await outcome("tenant", "ssh://git@git.lan/acme/api.git", { allowed: ["git.lan"] }),
    ).toBe("allowed");
    expect(
      await outcome("tenant", "https://10.0.0.5/acme/api.git", { allowed: ["10.0.0.0/8"] }),
    ).toBe("allowed");
    expect(
      await outcome("tenant", "https://[::1]/acme/api.git", {
        operator: true,
        allowed: ["::1/128"],
      }),
    ).toBe("refused");
    expect(await outcome("tenant", "git://github.com/acme/api.git")).toBe("refused");
    // A name that answers with any local address is refused, whatever else it answers.
    expect(await outcome("tenant", "https://rebind.example/acme/api.git")).toBe("refused");
    expect(await outcome("tenant", "https://nowhere.example/acme/api.git")).toBe("refused");
  });

  it("never names the addresses a host resolved to", async () => {
    const exit = await Effect.runPromise(
      policy("tenant")
        .check("ssh://git@git.lan/acme/api.git", { isOperator: false })
        .pipe(Effect.exit),
    );
    expect(JSON.stringify(exit)).not.toContain("10.0.0.5");
  });
});
