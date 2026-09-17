import { describe, expect, it } from "vitest";

import { redactDetail } from "./redact-detail.ts";

describe("redacting upstream detail from an error message", () => {
  it("keeps the sentence and removes where things live", () => {
    expect(
      redactDetail(
        "fatal: not a git repository: /var/lib/mend/store/prj_9f2/repo.git/worktrees/wt_1",
      ),
    ).toBe("fatal: not a git repository: <path>/wt_1");
    expect(
      redactDetail("ENOENT: no such file or directory, open '/home/mend/.config/mend/keys/id'"),
    ).toBe("ENOENT: no such file or directory, open '<path>/id'");
  });

  it("removes internal hosts, credentials and queries from URLs, and keeps public ones readable", () => {
    expect(
      redactDetail(
        "connect ECONNREFUSED http://sealant-api.sealant.svc:4000/v1/workspaces?ownerUserId=u",
      ),
    ).toBe("connect ECONNREFUSED http://<internal>/v1/workspaces");
    expect(
      redactDetail(
        "fatal: unable to access 'https://x-access-token:ghs_abcdefgh1234@github.com/acme/app.git/': 403",
      ),
    ).toBe("fatal: unable to access 'https://github.com/acme/app.git/': 403");
    expect(redactDetail("fetch failed: http://10.0.0.6:3900/bucket.")).toBe(
      "fetch failed: http://<internal>/bucket.",
    );
    expect(
      redactDetail(
        "upload refused by https://s3.eu-central-1.amazonaws.com/b/k?X-Amz-Signature=abc",
      ),
    ).toBe("upload refused by https://s3.eu-central-1.amazonaws.com/b/k");
  });

  it("removes bearers and anything long enough to be a secret", () => {
    expect(redactDetail("token mdt_4f9a8b7c6d5e rejected")).toBe("token <redacted> rejected");
    expect(redactDetail(`key ${"Zq".repeat(20)} is invalid`)).toBe("key ZqZqZqZq… is invalid");
    expect(redactDetail("the request sent Authorization: Bearer abc.def.ghi and failed")).toBe(
      "the request sent Authorization: Bearer <redacted> and failed",
    );
    expect(redactDetail("proxy said Basic dXNlcjpwYXNz")).toBe("proxy said Basic <redacted>");
    expect(
      redactDetail("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJl was refused"),
    ).toBe("jwt <redacted> was refused");
    expect(redactDetail("GET /api/tty?session=s1&token=short failed")).toBe(
      "GET /api/tty?session=s1&token=<redacted> failed",
    );
    expect(redactDetail("login failed for password=hunter2")).toBe(
      "login failed for password=<redacted>",
    );
    expect(redactDetail("key AKIAIOSFODNN7EXAMPLE rejected")).toBe("key <redacted> rejected");
    expect(redactDetail("secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY rejected")).toBe(
      "secret <redacted> rejected",
    );
  });

  it("keeps enough of a commit, a digest or a long branch name to say which one", () => {
    const sha = "9fceb02d0ae598e95dc970b74767f19372d61af8";
    expect(redactDetail(`checkpoint ${sha} not found`)).toBe("checkpoint 9fceb02d0ae5… not found");
    expect(redactDetail(`image sha256:${"ab".repeat(32)} is missing`)).toBe(
      "image sha256:abababababab… is missing",
    );
    expect(redactDetail(`branch ${"feature-".repeat(6)} does not exist`)).toBe(
      "branch feature-… does not exist",
    );
  });

  it("does not mistake a word for a server path", () => {
    for (const words of [
      "see /application/settings for that",
      "/nixos is not a project",
      "cannot read /apps/web/src/main.ts",
      "the /datasets route answered 404",
    ]) {
      expect(redactDetail(words)).toBe(words);
    }
    expect(redactDetail("open '~/.ssh/id_ed25519': permission denied")).toBe(
      "open '<path>/id_ed25519': permission denied",
    );
    expect(redactDetail("cannot open C:\\Users\\mend\\store\\repo.git")).toBe(
      "cannot open <path>/repo.git",
    );
    expect(redactDetail("stat /nix/store/abc-git/bin/git failed")).toBe("stat <path>/git failed");
  });

  it("leaves Mend's own words alone", () => {
    const words =
      'worktree "fix-login" is based on main — joining with base "develop" would silently re-base it';
    expect(redactDetail(words)).toBe(words);
    expect(redactDetail("Legacy bench sessions are review-only.")).toBe(
      "Legacy bench sessions are review-only.",
    );
    // A relative path and a route are the user's own, not the server's.
    expect(redactDetail("cannot read src/app/main.ts on branch mend/fix")).toBe(
      "cannot read src/app/main.ts on branch mend/fix",
    );
  });

  it("bounds the length", () => {
    expect(redactDetail("x ".repeat(1000)).length).toBeLessThanOrEqual(601);
  });
});
