import { McpServerId } from "@mend/domain";
import { McpServerName, McpServerUrl } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import type { McpServerDto } from "./api.ts";
import {
  buildWrite,
  draftOf,
  keepsSealedUrl,
  secretsLine,
  stateWords,
  targetLine,
} from "./mcp-servers.ts";

const AT = new Date("2026-11-09T10:00:00Z");

const server = (fields: Partial<McpServerDto> & Pick<McpServerDto, "transport">): McpServerDto => ({
  id: McpServerId.make("s1"),
  scope: "person",
  name: McpServerName.make("github"),
  secretNames: [],
  enabled: true,
  signIn: null,
  createdAt: AT,
  updatedAt: AT,
  ...fields,
});

const github = server({
  transport: { _tag: "stdio", command: "npx", args: ["-y", "@mcp/github"] },
  secretNames: ["GITHUB_TOKEN"],
});

const linear = server({
  name: McpServerName.make("linear"),
  transport: { _tag: "http", url: McpServerUrl.make("https://mcp.linear.app/mcp") },
  secretNames: ["Authorization"],
  signIn: { observedAt: AT, expiresAt: AT },
});

describe("the line under a server", () => {
  it("names the transport and what it reaches", () => {
    expect(targetLine(github.transport)).toBe("stdio · npx -y @mcp/github");
    expect(targetLine(linear.transport)).toBe("HTTP · https://mcp.linear.app/mcp");
  });

  it("names the saved values and never their contents", () => {
    expect(secretsLine(linear)).toBe("Mend sends your sealed Authorization header with each call.");
    expect(secretsLine(server({ ...github, secretNames: ["A", "B", "C"] }))).toBe(
      "Mend sets your sealed A, B and C variables when the server starts.",
    );
    expect(secretsLine(server({ ...github, secretNames: [] }))).toBeNull();
  });

  it("says a stdio server runs in the session and an HTTP one only when it is signed in", () => {
    expect(stateWords(github)).toBe("Runs in the session");
    expect(stateWords(linear)).toBe("Signed in");
    expect(stateWords({ ...linear, signIn: null })).toBeNull();
  });
});

const named = (name: string) =>
  buildWrite({ ...draftOf(null), name, url: "https://a.dev" }, null, ["linear"]);

describe("the add and edit form", () => {
  it("adds an HTTP server with a header", () => {
    const draft = {
      ...draftOf(null),
      name: "github",
      url: "https://api.githubcopilot.com/mcp/",
      added: [{ key: 0, name: "Authorization", value: "Bearer x" }],
    };
    expect(buildWrite(draft, null, [])).toEqual({
      _tag: "Write",
      write: {
        transport: { _tag: "http", url: "https://api.githubcopilot.com/mcp/" },
        secrets: { Authorization: { _tag: "Set", value: "Bearer x" } },
      },
    });
  });

  it("sends nothing until the name and the URL are filled, and an empty header row is skipped", () => {
    expect(buildWrite(draftOf(null), null, [])._tag).toBe("Incomplete");
    expect(buildWrite({ ...draftOf(null), name: "github" }, null, [])._tag).toBe("Incomplete");
    expect(buildWrite({ ...draftOf(null), name: "x", url: "https://a.dev/mcp" }, null, [])).toEqual(
      {
        _tag: "Write",
        write: { transport: { _tag: "http", url: "https://a.dev/mcp" }, secrets: {} },
      },
    );
  });

  it("says what is wrong with a name, a taken name or a URL, as a sentence", () => {
    expect(named("Bad Name")._tag).toBe("Issue");
    expect(named("linear")).toEqual({
      _tag: "Issue",
      issue: "You already have linear. Edit it instead.",
    });
    const url = buildWrite({ ...draftOf(null), name: "x", url: "ftp://a.dev" }, null, []);
    expect(url._tag).toBe("Issue");
    if (url._tag === "Issue") expect(url.issue).toMatch(/^[A-Z].*\.$/);
  });

  it("splits stdio arguments by line and drops blank lines", () => {
    const draft = {
      ...draftOf(null),
      name: "fs",
      kind: "stdio" as const,
      command: " npx ",
      args: "-y\n\n server \n",
    };
    expect(buildWrite(draft, null, [])).toEqual({
      _tag: "Write",
      write: { transport: { _tag: "stdio", command: "npx", args: ["-y", "server"] }, secrets: {} },
    });
  });

  it("keeps a saved value left empty, replaces one typed over, and leaves out one removed", () => {
    const saved = server({ ...github, secretNames: ["A", "B", "C"] });
    const draft = {
      ...draftOf(saved),
      saved: [
        { name: "A", value: "", removed: false },
        { name: "B", value: "new", removed: false },
        { name: "C", value: "", removed: true },
      ],
    };
    expect(buildWrite(draft, saved, ["github"])).toEqual({
      _tag: "Write",
      write: {
        transport: github.transport,
        secrets: { A: { _tag: "Keep" }, B: { _tag: "Set", value: "new" } },
      },
    });
  });

  it("drops saved variables when a stdio server becomes an HTTP one", () => {
    const draft = { ...draftOf(github), kind: "http" as const, url: "https://a.dev/mcp" };
    expect(buildWrite(draft, github, ["github"])).toEqual({
      _tag: "Write",
      write: { transport: { _tag: "http", url: "https://a.dev/mcp" }, secrets: {} },
    });
  });

  it("refuses a header named twice, in any case", () => {
    const draft = {
      ...draftOf(linear),
      added: [{ key: 0, name: "authorization", value: "x" }],
    };
    expect(buildWrite(draft, linear, ["linear"])).toEqual({
      _tag: "Issue",
      issue: "authorization is named twice.",
    });
  });

  it("never fills a saved value into the form", () => {
    expect(draftOf(github).saved).toEqual([{ name: "GITHUB_TOKEN", value: "", removed: false }]);
  });

  it("knows when the form sends back a sealed URL unchanged", () => {
    const sealed = server({
      ...linear,
      transport: { _tag: "http", url: McpServerUrl.make("https://a.dev/mcp?key=…") },
    });
    expect(keepsSealedUrl(draftOf(sealed), sealed)).toBe(true);
    expect(keepsSealedUrl({ ...draftOf(sealed), url: "https://a.dev/mcp" }, sealed)).toBe(false);
  });
});
