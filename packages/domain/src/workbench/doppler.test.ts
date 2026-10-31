import { Redacted, Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  DopplerConnectionInput,
  dopplerConfigContents,
  dopplerSelectionIssue,
  dopplerTokenIssue,
  isMendDopplerConfig,
} from "./doppler.ts";

describe("Doppler config and write-only connection", () => {
  it("uses the actual CLI keys and scopes; personal, CLI and service tokens have the same posture", () => {
    for (const token of ["dp.pt.fake", "dp.ct.fake", "dp.st.fake", "future-kind"]) {
      const parsed = Schema.decodeUnknownSync(DopplerConnectionInput)({ token });
      expect(Redacted.value(parsed.token)).toBe(token);
      expect(JSON.stringify(parsed)).not.toContain(token);
      expect(dopplerTokenIssue(token)).toBeNull();
      const text = dopplerConfigContents(token, "/workspace/repo", {
        dopplerProject: "backend",
        config: "dev_me",
      });
      expect(JSON.parse(text).scoped).toEqual({
        "/": { token },
        "/workspace/repo": { "enclave.project": "backend", "enclave.config": "dev_me" },
      });
      expect(isMendDopplerConfig(JSON.parse(text))).toBe(true);
    }
    expect(dopplerSelectionIssue({ dopplerProject: "backend", config: "../prd" })).not.toBeNull();
  });

  it("round-trips arbitrary config data and preserves a later local login or edit", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 100 }), fc.string(), (token, worktree) => {
        const contents = dopplerConfigContents(token, worktree || "/workspace/repo", null);
        const parsed = JSON.parse(contents);
        expect(parsed.scoped["/"].token).toBe(token);
        expect(isMendDopplerConfig(parsed)).toBe(true);
        parsed.scoped["/"].token = token + "changed";
        expect(isMendDopplerConfig(parsed)).toBe(false);
        expect(isMendDopplerConfig({ scoped: parsed.scoped })).toBe(false);
      }),
    );
  });
});
