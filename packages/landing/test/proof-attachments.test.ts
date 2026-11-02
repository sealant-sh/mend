import { createHash } from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import {
  ProofArtifactsRepo,
  PullRequestProofUploadsRepo,
  type PullRequestProofUpload,
} from "@mend/db";
import {
  ChangeId,
  CheckpointId,
  ProjectId,
  ProofArtifactId,
  ScreenId,
  SessionId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import {
  describePullRequest,
  mergeDescription,
  ProofArtifact,
  type DescriptionInput,
} from "@mend/domain/workbench";
import { BlobStore } from "@mend/store";
import { Effect, Layer } from "effect";

import {
  PullRequests,
  PullRequestsLive,
  PullRequestWorkspaces,
  type ExecOutput,
} from "../src/pull-requests.ts";

const repository = { owner: "acme", name: "api", slug: "Acme/API" };
const changeId = ChangeId.make("change");
const observed = new Date("2026-11-01T14:02:00Z");
const content = Buffer.from([0, 1, 255, 127, 0, 128]);
const hash = createHash("sha256").update(content).digest("hex");
const capture = (id: string, video = false) =>
  new ProofArtifact({
    id: ProofArtifactId.make(id),
    changeId,
    worktreeId: WorktreeId.make("worktree"),
    projectId: ProjectId.make("project"),
    sessionId: SessionId.make("session"),
    turnId: null,
    title: video ? "Board flow" : `Board ${id}`,
    caption: "Completed task",
    source: {
      _tag: "Checkpoint",
      checkpointId: CheckpointId.make("checkpoint"),
      ordinal: 2,
      commit: Sha.make("c".repeat(40)),
    },
    capture: video
      ? {
          _tag: "Video",
          span: { screenId: ScreenId.make("screen"), fromSeq: 1, toSeq: 2 },
          media: { blobKey: id, bytes: content.length, sha256: hash, mimeType: "video/mp4" },
          durationMs: 1000,
          ending: "stopped",
        }
      : {
          _tag: "Screenshot",
          moment: { screenId: ScreenId.make("screen"), seq: 1 },
          media: { blobKey: id, bytes: content.length, sha256: hash, mimeType: "image/png" },
        },
    launch: null,
    differences: null,
    observedFrom: observed,
    observedTo: observed,
    createdAt: observed,
  });
const description: DescriptionInput = {
  tour: { summary: "Update board", approach: null },
  files: [],
  checks: [],
  checkpoint: { ordinal: 5, sha: "a".repeat(40) },
  links: { session: null, review: null, checkpoint: null },
};
const ok = (stdout = ""): ExecOutput => ({ exitCode: 0, stdout, stderr: "" });

const flag = (argv: ReadonlyArray<string>, name: string) =>
  argv.find((word) => word.startsWith(`--${name}=`))?.slice(name.length + 3) ?? "";

const harness = (
  options: {
    readonly noAttach?: boolean;
    readonly video422?: boolean;
    readonly checksumWrong?: boolean;
    readonly artifacts?: ReadonlyArray<ProofArtifact>;
  } = {},
) => {
  const artifacts = [
    ...(options.artifacts ?? [capture("one"), capture("two"), capture("video", true)]),
  ];
  const rows: Array<PullRequestProofUpload> = [];
  const files = new Map<string, Buffer>();
  const commands: Array<ReadonlyArray<string>> = [];
  const workspaces: Array<string> = [];
  let body = "Person's introduction\n\nPerson's closing text";
  let uploads = 0;
  const exec = (argv: ReadonlyArray<string>): ExecOutput => {
    commands.push(argv);
    if (argv[0] === "mkdir" || argv[0] === "rm") return ok();
    if (argv[0] === "sh") {
      const file = argv[4] ?? "";
      const chunk = Buffer.from(argv.slice(5).join(""), "base64");
      files.set(
        file,
        argv[2]?.includes(">>")
          ? Buffer.concat([files.get(file) ?? Buffer.alloc(0), chunk])
          : chunk,
      );
      return ok();
    }
    if (argv[0] === "sha256sum")
      return ok(
        `${
          options.checksumWrong
            ? "bad"
            : createHash("sha256")
                .update(files.get(argv.at(-1) ?? "") ?? Buffer.alloc(0))
                .digest("hex")
        }  file`,
      );
    expect(argv).toContain("GH_TELEMETRY=0");
    const ghAt = argv.indexOf("gh");
    const verb = argv[ghAt + 2];
    if (verb === "list") return ok("[]");
    if (verb === "view")
      return ok(
        JSON.stringify({
          number: 42,
          url: "https://github.com/acme/api/pull/42",
          state: "OPEN",
          title: "Board",
          body,
        }),
      );
    if (verb === "create" || verb === "edit") {
      let next = files.get(flag(argv, "body-file"))?.toString("utf8") ?? "";
      for (const word of argv.filter((argument) => argument.startsWith("--attach="))) {
        const file = word.slice("--attach=".length);
        if (file.endsWith(".mp4") && options.video422) {
          body = next;
          return {
            exitCode: 1,
            stdout: "",
            stderr: `HTTP 422 /tmp/private-path ghs_do-not-publish`,
          };
        }
        expect(files.get(file)).toEqual(content);
        const url = `https://github.com/user-attachments/assets/asset-${++uploads}`;
        next = file.endsWith(".mp4")
          ? next.replace(`![](${file})`, url)
          : next.replaceAll(file, url);
      }
      body = next;
      return ok("https://github.com/acme/api/pull/42");
    }
    throw new Error(`unexpected fake command ${argv.join(" ")}`);
  };
  const layer = PullRequestsLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProofArtifactsRepo, { listForChange: () => Effect.succeed(artifacts) }),
        Layer.succeed(PullRequestProofUploadsRepo, {
          listForChange: (_changeId, slug) =>
            Effect.succeed(rows.filter((row) => row.repository === slug.toLowerCase())),
          record: (input) =>
            Effect.sync(() => {
              if (
                !rows.some(
                  (row) =>
                    row.artifactId === input.artifactId &&
                    row.repository === input.repository.toLowerCase(),
                )
              )
                rows.push({
                  ...input,
                  repository: input.repository.toLowerCase(),
                  createdAt: observed,
                });
            }),
        }),
        Layer.mock(BlobStore, { identity: "fake-proof", get: () => Effect.succeed(content) }),
        Layer.succeed(PullRequestWorkspaces, {
          within: (target, use) => {
            const kind = target.sessionId === null ? "short-lived" : "session";
            workspaces.push(kind);
            return use({
              kind,
              supportsAttachments: !options.noAttach,
              exec: (argv) => Effect.sync(() => exec(argv)),
            });
          },
        }),
      ),
    ),
  );
  const input = {
    target: { ownerUserId: "ada", sessionId: SessionId.make("session") },
    repository,
    changeId,
    number: 42,
    section: describePullRequest(description),
    checkpointOrdinal: 5,
  };
  return {
    layer,
    input,
    rows,
    artifacts,
    commands,
    workspaces,
    body: () => body,
    uploads: () => uploads,
    setBody: (next: string) => {
      body = next;
    },
  };
};

describe("proof attachments in the PR body", () => {
  it.effect(
    "publishes two screenshots and a standalone video, then reuses all uploads on re-landing",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        const prs = yield* PullRequests;
        const section = describePullRequest({
          ...description,
          media: yield* prs.proofItems(changeId, repository),
        });
        h.setBody(`Person's introduction\n\n${section}\n\nPerson's closing text`);
        const published = yield* prs.publish({
          target: h.input.target,
          repository,
          head: "mend/board",
          base: "main",
          title: "Board",
          titleGiven: false,
          section,
          body: null,
          previous: 42,
        });
        expect(published.action).toBe("updated");
        expect(yield* prs.attachProof(h.input)).toEqual({ delivered: 3, reused: 0, failed: [] });
        const first = h.body();
        expect(first).toContain(
          "Board one · checkpoint #2 · observed 14:02 UTC · landed checkpoint #5",
        );
        expect(first).toContain("![Board one");
        expect(first).toContain("\n\nhttps://github.com/user-attachments/assets/asset-3\n");
        expect(first.startsWith("Person's introduction\n\n")).toBe(true);
        expect(first.endsWith("\n\nPerson's closing text")).toBe(true);
        expect(first).not.toContain("/tmp/");
        expect(h.rows.map((row) => row.repository)).toEqual(["acme/api", "acme/api", "acme/api"]);
        expect(yield* prs.attachProof(h.input)).toEqual({ delivered: 0, reused: 3, failed: [] });
        expect(h.uploads()).toBe(3);
        expect(h.body()).toBe(first);
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect("cleans the partial body after a video 422 and reports the same short reason", () => {
    const h = harness({ video422: true });
    return Effect.gen(function* () {
      const report = yield* (yield* PullRequests).attachProof(h.input);
      expect(report).toEqual({
        delivered: 2,
        reused: 0,
        failed: [{ artifactId: "video", reason: "GitHub refused the upload (HTTP 422)" }],
      });
      expect(h.body()).toContain(
        "Board flow · checkpoint #2 · observed 14:02 UTC · landed checkpoint #5 · not delivered · GitHub refused the upload (HTTP 422)",
      );
      expect(h.body()).not.toMatch(/\/tmp\/|ghs_/);
      const edits = h.commands.filter((argv) => argv.includes("edit") && !argv.includes("--help"));
      expect(edits).toHaveLength(2);
      expect(edits.at(-1)?.some((word) => word.startsWith("--attach="))).toBe(false);
      expect(h.rows).toHaveLength(2);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect(
    "reports unavailable when neither gh supports attachments, without a link substitute",
    () => {
      const h = harness({ noAttach: true });
      return Effect.gen(function* () {
        const report = yield* (yield* PullRequests).attachProof(h.input);
        expect(report.unavailable).toBe("gh has no --attach");
        expect(report.failed).toHaveLength(3);
        expect(h.body()).toContain("not delivered · gh has no --attach");
        expect(h.body()).not.toMatch(/\/tmp\/|!\[/);
        expect(h.uploads()).toBe(0);
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect("batches at fifty files and uploads the video after the screenshots", () => {
    const h = harness({
      artifacts: [
        capture("video", true),
        ...Array.from({ length: 51 }, (_, index) => capture(`image-${index}`)),
      ],
    });
    return Effect.gen(function* () {
      const report = yield* (yield* PullRequests).attachProof(h.input);
      expect(report).toEqual({ delivered: 52, reused: 0, failed: [] });
      const attached = h.commands
        .map((argv) => argv.filter((word) => word.startsWith("--attach=")))
        .filter((batch) => batch.length > 0);
      expect(attached.map((batch) => batch.length)).toEqual([50, 2]);
      expect(attached.at(-1)?.at(-1)).toMatch(/video\.mp4$/);
      expect(h.body()).not.toContain("/tmp/");
      expect(h.body()).toContain("\n\nhttps://github.com/user-attachments/assets/asset-52\n");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("describes recordings and captures that were not taken without uploading them", () => {
    const screenshot = capture("missing");
    const video = capture("recording", true);
    const h = harness({
      artifacts: [
        new ProofArtifact({
          ...screenshot,
          capture: { _tag: "NotCaptured", kind: "screenshot", reason: "No test account" },
        }),
        new ProofArtifact({
          ...video,
          capture: { _tag: "Recording", screenId: ScreenId.make("screen"), fromSeq: 1 },
        }),
      ],
    });
    return Effect.gen(function* () {
      const report = yield* (yield* PullRequests).attachProof(h.input);
      expect(report.failed).toEqual([
        { artifactId: "missing", reason: "No test account" },
        { artifactId: "recording", reason: "recording in progress" },
      ]);
      expect(h.uploads()).toBe(0);
      expect(h.body()).toContain("not captured · No test account");
      expect(h.body()).toContain("not delivered · recording in progress");
      expect(h.body()).not.toContain("![");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("refuses to upload a file whose staged checksum differs", () => {
    const h = harness({ checksumWrong: true });
    return Effect.gen(function* () {
      const report = yield* (yield* PullRequests).attachProof(h.input);
      expect(report.failed.every((item) => item.reason === "staged media checksum differs")).toBe(
        true,
      );
      expect(h.uploads()).toBe(0);
      expect(h.body()).not.toContain("/tmp/");
    }).pipe(Effect.provide(h.layer));
  });

  it("escapes labels and marks older checkpoints while preserving the person's text", () => {
    const section = describePullRequest({
      ...description,
      media: [
        {
          artifactId: ProofArtifactId.make("label"),
          label: "Board [done] \\ `code` -->",
          kind: "screenshot",
          checkpointOrdinal: 2,
          ref: { url: "https://github.com/user-attachments/assets/label" },
        },
      ],
    });
    expect(section).toContain("Board \\[done\\] \\\\ \\`code\\` --\\>");
    expect(section).toContain("landed checkpoint #5");
    expect(mergeDescription(`Before\n${section}\nAfter`, section)).toBe(
      `Before\n${section}\nAfter`,
    );
    expect(
      mergeDescription(`Before\n${section}\nAfter`, describePullRequest(description)),
    ).toContain("https://github.com/user-attachments/assets/label");
  });
});
