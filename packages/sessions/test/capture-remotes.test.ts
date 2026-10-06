import { ProjectId } from "@mend/domain";
import { Project } from "@mend/domain/workbench";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { CaptureRemotes, CaptureRemotesLive, workspaceRemoteUrl } from "../src/capture-remotes.ts";
import { projectFor, projectsFor } from "./capture-world.ts";

describe("workspaceRemoteUrl", () => {
  it("keeps a URL that holds no credential exactly as adopted", () => {
    for (const url of [
      "git@github.com:acme/api.git",
      "ssh://git@host.example:2222/srv/git/api.git",
      "git+ssh://git@host.example/srv/git/api.git",
      "https://github.com/acme/api.git",
      "http://host.example:8080/acme/api.git",
      "file:///srv/git/api.git",
      "/srv/git/api.git",
    ]) {
      expect(workspaceRemoteUrl(url)).toBe(url);
    }
  });

  it("drops every form of credential an HTTP(S) user part can hold, and still names the repository", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["https://deploy:s3cret@host.example/acme/api.git", "https://host.example/acme/api.git"],
      // A token held as the user name alone.
      [
        "https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/o/r.git",
        "https://github.com/o/r.git",
      ],
      ["https://x-access-token:ghs_abc@github.com/o/r.git", "https://github.com/o/r.git"],
      ["https://oauth2:glpat-xyz@gitlab.com/o/r.git", "https://gitlab.com/o/r.git"],
      ["https://deploy@host.example/acme/api.git", "https://host.example/acme/api.git"],
      ["https://:token-only@host.example/acme/api.git", "https://host.example/acme/api.git"],
      // Percent-encoded, with a port and a query.
      [
        "https://us%40er:p%3Ass@host.example:8443/acme/api.git?x=1",
        "https://host.example:8443/acme/api.git?x=1",
      ],
      ["http://user:pass@host.example/acme/api.git", "http://host.example/acme/api.git"],
    ];
    for (const [adopted, kept] of cases) {
      expect(workspaceRemoteUrl(adopted), adopted).toBe(kept);
    }
  });

  it("keeps an SSH user name, the login the host is reached as, and drops only a password", () => {
    expect(workspaceRemoteUrl("ssh://git:s3cret@host.example/srv/git/api.git")).toBe(
      "ssh://git@host.example/srv/git/api.git",
    );
    expect(workspaceRemoteUrl("git+ssh://deploy:s3cret@host.example/api.git")).toBe(
      "git+ssh://deploy@host.example/api.git",
    );
  });
});

const remotesOf = (project: Project, id: ProjectId) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* CaptureRemotes;
      return yield* service.forProject(id);
    }).pipe(Effect.provide(CaptureRemotesLive.pipe(Layer.provide(projectsFor(project))))),
  );

describe("CaptureRemotesLive", () => {
  const adopted = projectFor("/store/fixture/repo.git", "0".repeat(40));
  const withOrigin = new Project({ ...adopted, originUrl: "git@example.invalid:acme/api.git" });

  it("names the project's origin", async () => {
    expect(await remotesOf(withOrigin, withOrigin.id)).toEqual([
      { name: "origin", url: "git@example.invalid:acme/api.git" },
    ]);
  });

  it("names nothing for a project without an origin, or one it cannot read", async () => {
    expect(await remotesOf(adopted, adopted.id)).toEqual([]);
    expect(await remotesOf(withOrigin, ProjectId.make("proj-nobody-adopted"))).toEqual([]);
  });
});
