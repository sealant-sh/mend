import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SETUP_SESSION_PROMPT } from "@mend/domain/workbench";
import { parseMendToml, resolveDeclarations } from "@mend/sessions";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

describe("setup session recipe output contract", () => {
  it("gives an executable recipe example accepted by Mend's parser and declaration checks", () => {
    const examples = [...SETUP_SESSION_PROMPT.matchAll(/```toml\n([\s\S]*?)\n```/g)];
    expect(
      examples.length,
      "the prompt must teach the actual recipe schema with TOML",
    ).toBeGreaterThan(0);
    for (const example of examples) {
      const toml = example[1];
      if (toml === undefined) throw new Error("a TOML fence must contain the recipe");
      const file = Effect.runSync(parseMendToml(toml, ".mend/mend.toml"));
      const declarations = resolveDeclarations(file, []);
      expect(declarations.refused).toEqual([]);
      expect(declarations.ignored).toEqual([]);
      expect(declarations.setup).toMatchObject({
        run: ["pnpm install --frozen-lockfile"],
        inputs: ["package.json", "pnpm-lock.yaml"],
      });
      expect(declarations.preview).toMatchObject({ service: "web" });
      expect(declarations.recipes).toEqual([
        expect.objectContaining({
          name: "web",
          port: 3000,
          protocol: "tcp",
          browserScheme: "http",
          host: "preserve",
          command: expect.stringContaining("--strictPort"),
        }),
      ]);
    }
  });

  it.each(["unapproved", "approved", "no-builds", "unrelated-error"])(
    "executes the prompt's install guard with %s dependencies",
    (scenario) => {
      const example = SETUP_SESSION_PROMPT.match(/```sh\n([\s\S]*?)\n```/);
      const command = example?.[1];
      expect(command, "the prompt must teach a runnable pnpm install guard").toBeDefined();
      if (command === undefined) throw new Error("missing install guard example");
      const dir = mkdtempSync(join(tmpdir(), "mend-setup-pnpm-"));
      try {
        // An inert pnpm command models only its CLI output and exit status. No install runs.
        writeFileSync(
          join(dir, "pnpm"),
          `#!/bin/sh
printf '%s\\n' "$*" > "$PNPM_TEST_CALL"
case "$PNPM_TEST_SCENARIO" in
  unapproved)
    echo 'ERR_PNPM_IGNORED_BUILDS Ignored build scripts: esbuild@0.21.5' >&2
    echo 'Run pnpm approve-builds to pick dependencies.' >&2
    exit 1 ;;
  unrelated-error)
    echo 'ERR_PNPM_OUTDATED_LOCKFILE Cannot install with frozen-lockfile' >&2
    exit 17 ;;
  *) echo 'Dependencies installed' ;;
esac
`,
          { mode: 0o700 },
        );
        const result = spawnSync("/bin/sh", ["-eu", "-c", command], {
          cwd: dir,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH ?? ""}`,
            TMPDIR: dir,
            PNPM_TEST_CALL: join(dir, "called"),
            PNPM_TEST_SCENARIO: scenario,
          },
        });
        expect(result.error).toBeUndefined();
        expect(readFileSync(join(dir, "called"), "utf8")).toBe("install --frozen-lockfile\n");
        expect(readdirSync(dir).toSorted()).toEqual(["called", "pnpm"]);
        if (scenario === "unapproved") {
          expect(result.status).toBe(1);
          expect(result.stdout).toBe("");
          expect(result.stderr).toBe(
            "setup.run (pnpm install): esbuild@0.21.5 needs build-script approval; run pnpm approve-builds and commit the result, or add esbuild to onlyBuiltDependencies.\n",
          );
        } else if (scenario === "unrelated-error") {
          expect(result.status).toBe(17);
          expect(result.stderr).toBe(
            "ERR_PNPM_OUTDATED_LOCKFILE Cannot install with frozen-lockfile\n",
          );
        } else {
          expect(result.status).toBe(0);
          expect(result.stdout).toBe("Dependencies installed\n");
          expect(result.stderr).toBe("");
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
