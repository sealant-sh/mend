import { GitError } from "@mend/store";
import { describe, expect, it } from "vitest";

import { gitWords } from "../src/git-words.ts";

const pushFailure = (stderr: string) =>
  new GitError({ args: ["push", "origin"], cwd: "/store/repo.git", exitCode: 128, stderr });

describe("gitWords", () => {
  it("a push to an https origin that wants a credential names the ssh URL, not the Mend key", () => {
    const words = gitWords(
      pushFailure(
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      ),
      "mend-key",
      "https://github.com/acme/api.git",
    );
    expect(words).toContain("git@github.com:acme/api.git");
    expect(words).not.toContain("Add your Mend public key");
  });

  it("an ssh origin's refusal still names the Mend key", () => {
    const words = gitWords(
      pushFailure("git@github.com: Permission denied (publickey)."),
      "mend-key",
      "git@github.com:acme/api.git",
    );
    expect(words).toContain("Add your Mend public key");
  });
});
