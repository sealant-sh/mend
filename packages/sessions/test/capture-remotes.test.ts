import { ProjectId } from "@mend/domain";
import { Project } from "@mend/domain/workbench";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { CaptureRemotes, CaptureRemotesLive, workspaceRemoteUrl } from "../src/capture-remotes.ts";
import { projectFor, projectsFor } from "./capture-world.ts";

describe("workspaceRemoteUrl", () => {
  it("keeps a URL that holds no password exactly as adopted", () => {
    for (const url of [
      "git@github.com:acme/api.git",
      "ssh://git@host.example:2222/srv/git/api.git",
      "https://github.com/acme/api.git",
      "https://deploy@host.example/acme/api.git",
    ]) {
      expect(workspaceRemoteUrl(url)).toBe(url);
    }
  });

  it("drops a password, so no credential enters a workspace, and still names the repository", () => {
    expect(workspaceRemoteUrl("https://deploy:s3cret@host.example/acme/api.git")).toBe(
      "https://deploy@host.example/acme/api.git",
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
