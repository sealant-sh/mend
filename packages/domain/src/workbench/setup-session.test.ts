import { describe, expect, it } from "vitest";

import { SETUP_SESSION_PROMPT } from "./setup-session.ts";

describe("setup session authentication output contract", () => {
  it("requires a findable authentication section and provider registration table in verify.md", () => {
    expect(SETUP_SESSION_PROMPT).toContain(
      "Every .mend/verify.md must include this Markdown structure",
    );
    for (const heading of [
      "## Authentication",
      "### Providers and configuration",
      "### Addresses and provider registration",
      "### Sign-in for checks",
      "### Missing prerequisites",
    ]) {
      expect(SETUP_SESSION_PROMPT).toContain(heading);
    }
    expect(SETUP_SESSION_PROMPT).toContain(
      "| Provider or method | Configuration source | Required env names | Callback or redirect paths |",
    );
    expect(SETUP_SESSION_PROMPT).toContain(
      "| Access | App origin | Callback URLs | Register at | Allowed origins and cookie settings | Status |",
    );
  });

  it("discovers the app's auth methods and sources rather than assuming OAuth", () => {
    for (const method of ["OAuth", "OIDC", "magic links", "password", "SSO"]) {
      expect(SETUP_SESSION_PROMPT).toContain(method);
    }
    expect(SETUP_SESSION_PROMPT).toContain("source paths");
    expect(SETUP_SESSION_PROMPT).toContain("no authentication found");
    expect(SETUP_SESSION_PROMPT).toContain("unknown");
  });

  it("pins the app's workspace port while distinguishing the external preview address", () => {
    expect(SETUP_SESSION_PROMPT).toContain("fixed port");
    expect(SETUP_SESSION_PROMPT).toContain("PORT");
    expect(SETUP_SESSION_PROMPT).toContain("fail if the port is occupied");
    expect(SETUP_SESSION_PROMPT).toContain("http://localhost:<fixed-port>");
    expect(SETUP_SESSION_PROMPT).toContain("ts.net");
    expect(SETUP_SESSION_PROMPT).toContain("each new worktree needs its own provider registration");
  });

  it("requires later discovery steps for an unknown preview origin without starting it during setup", () => {
    expect(SETUP_SESSION_PROMPT).toContain('record "unknown"');
    expect(SETUP_SESSION_PROMPT).toContain("Never invent a preview URL");
    expect(SETUP_SESSION_PROMPT).toContain("Open in a new tab");
    expect(SETUP_SESSION_PROMPT).toContain("MEND_PREVIEW_URL");
    expect(SETUP_SESSION_PROMPT).toContain("append each callback path");
    expect(SETUP_SESSION_PROMPT).toContain("not /preview-auth or /__mend/auth");
    expect(SETUP_SESSION_PROMPT).toContain("Study and write only");
    expect(SETUP_SESSION_PROMPT).toContain("Do not run setup commands");
  });

  it("records the provider's manual configuration and gateway callback constraints", () => {
    expect(SETUP_SESSION_PROMPT).toContain("provider console");
    expect(SETUP_SESSION_PROMPT).toContain("Mend cannot register callbacks");
    expect(SETUP_SESSION_PROMPT).toContain("SameSite");
    expect(SETUP_SESSION_PROMPT).toContain("X-Forwarded-Host");
    expect(SETUP_SESSION_PROMPT).toContain("cross-origin POST");
    expect(SETUP_SESSION_PROMPT).toContain("form_post");
  });

  it("keeps D11 runnable without committing or printing auth material", () => {
    expect(SETUP_SESSION_PROMPT).toContain(".mend/create-test-session.<ext>");
    expect(SETUP_SESSION_PROMPT).toContain("seed script");
    expect(SETUP_SESSION_PROMPT).toContain("sign-up flow");
    expect(SETUP_SESSION_PROMPT).toContain(
      "cookie name, domain, path, Secure, HttpOnly and SameSite",
    );
    expect(SETUP_SESSION_PROMPT).toContain("cleanup");
    expect(SETUP_SESSION_PROMPT).toContain("Every screen has a fresh browser profile");
    expect(SETUP_SESSION_PROMPT).toContain(
      "Never write secret values, signed cookies or tokens into .mend/",
    );
    expect(SETUP_SESSION_PROMPT).toContain(
      "without printing them or putting values in tool arguments",
    );
    expect(SETUP_SESSION_PROMPT).toContain("do not fabricate a session format");
  });
});
