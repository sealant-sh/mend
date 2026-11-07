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
        inputs: ["pnpm-lock.yaml"],
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
});
