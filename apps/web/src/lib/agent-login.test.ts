import { ConnectedAccount } from "@mend/api-contracts";
import { describe, expect, it } from "vitest";

import {
  accountFacts,
  agentLoginNote,
  agentLoginState,
  anyAgentConnected,
  connectCommand,
  connectedLine,
  initialAgent,
  keyProblem,
  refusedWords,
  savedAgentLine,
} from "./agent-login.ts";

const connectedAt = new Date("2026-11-18T10:00:00.000Z");

const account = (
  fields: Partial<ConnectedAccount> & Pick<ConnectedAccount, "id" | "provider">,
): ConnectedAccount =>
  ConnectedAccount.make({
    name: "default",
    kind: "oauth-token",
    status: "active",
    metadata: {},
    connectedAt,
    updatedAt: connectedAt,
    lastUsedAt: null,
    isDefault: true,
    login: { kind: "subscription" },
    ...fields,
  });

const claude = account({
  id: "c1",
  provider: "claude",
  metadata: { email: "linus@northwind.dev" },
});
const codexKey = account({
  id: "x1",
  provider: "codex",
  kind: "api-key",
  login: { kind: "api-key", suffix: "a91f" },
});
const github = account({ id: "g1", provider: "github", kind: "gh-cli-token", login: undefined });

describe("agentLoginState", () => {
  it("reads none when the person has no login for the agent", () => {
    expect(agentLoginState([github], "claude")).toEqual({ kind: "none" });
  });

  it("reads connected for the chosen login, and says whether it is a key", () => {
    expect(agentLoginState([claude], "claude")).toEqual({
      kind: "connected",
      account: claude,
      key: false,
    });
    expect(agentLoginState([codexKey], "codex")).toMatchObject({ kind: "connected", key: true });
  });

  it("uses another login that works when the chosen one was refused", () => {
    const refused = account({ id: "c2", provider: "claude", status: "invalid" });
    const other = account({ id: "c3", provider: "claude", name: "work", isDefault: false });
    expect(agentLoginState([refused, other], "claude")).toMatchObject({
      kind: "connected",
      account: { id: "c3" },
    });
  });

  it("reads refused when every login for the agent was refused", () => {
    const refused = account({ id: "c2", provider: "claude", status: "invalid" });
    expect(agentLoginState([refused], "claude")).toMatchObject({ kind: "refused", key: false });
  });

  it("ignores archived logins", () => {
    const archived = account({ id: "c4", provider: "claude", status: "archived" });
    expect(agentLoginState([archived], "claude")).toEqual({ kind: "none" });
  });
});

describe("what Continue and the steps read", () => {
  it("counts only Claude Code and Codex logins that work", () => {
    expect(anyAgentConnected([github])).toBe(false);
    expect(anyAgentConnected([account({ id: "c2", provider: "claude", status: "invalid" })])).toBe(
      false,
    );
    expect(anyAgentConnected([github, codexKey])).toBe(true);
  });

  it("opens on the agent already connected, else Claude Code", () => {
    expect(initialAgent([])).toBe("claude");
    expect(initialAgent([codexKey])).toBe("codex");
    expect(initialAgent([claude, codexKey])).toBe("claude");
  });

  it("names the connected agents under the step once it is done", () => {
    expect(savedAgentLine([])).toBe("");
    expect(savedAgentLine([codexKey])).toBe("Codex");
    expect(savedAgentLine([claude, codexKey])).toBe("Claude Code and Codex");
  });

  it("says what Continue needs, or what to keep in mind once it opens", () => {
    expect(agentLoginNote([], { agent: "claude", mode: "command" })).toBe(
      "You need an agent login to start a session.",
    );
    expect(agentLoginNote([claude], { agent: "claude", mode: "command" })).toBe(
      "You can change this login later in Settings.",
    );
    expect(agentLoginNote([codexKey], { agent: "codex", mode: "key" })).toBe(
      "Mend stores the key and never shows it again.",
    );
  });
});

describe("the words", () => {
  it("shows the command the CLI has", () => {
    expect(connectCommand("claude")).toBe("mend connect claude");
    expect(connectCommand("codex")).toBe("mend connect codex");
  });

  it("says which account a connected login uses", () => {
    expect(connectedLine("claude", false)).toBe(
      "Claude Code is connected. Claude Code sessions will use this Claude account.",
    );
    expect(connectedLine("codex", true)).toBe(
      "Codex is connected with an OpenAI API key. Codex sessions will use it.",
    );
  });

  it("names the account's owner and kind, and never any part of a key", () => {
    expect(accountFacts(claude)).toBe("linus@northwind.dev · subscription");
    expect(accountFacts(codexKey)).toBe("API key");
    expect(accountFacts(codexKey)).not.toContain("a91f");
    expect(
      accountFacts(account({ id: "x2", provider: "codex", metadata: { accountId: "acct-9" } })),
    ).toBe("acct-9 · subscription");
  });

  it("tells a refused login to connect again the way it was connected", () => {
    expect(refusedWords("claude", false)).toEqual({
      title: "Your Claude Code login needs connecting again.",
      advice: "Claude refused it, so Claude Code sessions can't start. Run the command again.",
    });
    expect(refusedWords("codex", true).title).toBe("OpenAI refused your API key.");
  });
});

describe("keyProblem", () => {
  it("accepts a key of the agent's issuer", () => {
    expect(keyProblem("codex", "sk-proj-abc")).toBeNull();
    expect(keyProblem("claude", "sk-ant-api03-abc")).toBeNull();
  });

  it("refuses an empty field, a key with spaces, and the other issuer's key", () => {
    expect(keyProblem("codex", "")?.title).toBe("Paste a key.");
    expect(keyProblem("codex", "sk-proj abc")?.title).toBe(
      "That key has a space or a line break in it.",
    );
    expect(keyProblem("claude", "sk-proj-abc")).toEqual({
      title: "That isn't an Anthropic API key.",
      advice:
        "Anthropic keys start with sk-ant-. Paste another key here, or create a new one in the Anthropic Console.",
    });
    expect(keyProblem("codex", "not-a-key")?.title).toBe("That isn't an OpenAI API key.");
  });
});
