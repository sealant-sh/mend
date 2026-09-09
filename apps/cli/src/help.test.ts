import { describe, expect, it } from "vitest";

import {
  COMMANDS,
  SECTIONS,
  commandGroup,
  findCommand,
  renderCommand,
  renderGroup,
  renderIndex,
  renderManIndex,
  renderManPage,
  roff,
  usageOf,
  wrap,
} from "./help.ts";

const visible = COMMANDS.filter((doc) => !doc.hidden);

describe("the catalog", () => {
  it("keeps every summary short, lowercase, and free of the tells", () => {
    for (const doc of COMMANDS) {
      expect(doc.summary.length, doc.name).toBeLessThanOrEqual(64);
      expect(doc.summary, doc.name).toMatch(/^[a-z~/]/);
      expect(doc.summary, doc.name).not.toMatch(/[—–]/);
      expect(doc.summary.endsWith("."), doc.name).toBe(false);
    }
  });

  it("writes descriptions without em dashes or curly quotes", () => {
    for (const doc of COMMANDS) {
      for (const text of [...doc.description, ...(doc.options ?? []).map((o) => o.text)]) {
        expect(text, doc.name).not.toMatch(/[—–“”‘’]/);
      }
    }
  });

  it("names only real pages in see-also", () => {
    for (const doc of COMMANDS) {
      for (const name of doc.see ?? []) {
        expect(findCommand(name.split(" "))?.name, `${doc.name} → ${name}`).toBe(name);
      }
    }
  });

  it("has no duplicate names or aliases", () => {
    const names = COMMANDS.flatMap((doc) => [doc.name, ...(doc.aliases ?? [])]);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("findCommand", () => {
  it("resolves aliases, subcommands, and the longest match", () => {
    expect(findCommand(["claude"])?.name).toBe("codex");
    expect(findCommand(["service", "run"])?.name).toBe("service run");
    expect(findCommand(["server", "setup"])?.name).toBe("server setup");
    expect(findCommand(["service", "run", "web"])?.name).toBe("service run");
    expect(findCommand(["status"])?.name).toBe("sessions");
    expect(findCommand(["service"])).toBeNull();
    expect(findCommand(["nope"])).toBeNull();
    expect(findCommand([])).toBeNull();
  });

  it("groups a family", () => {
    expect(commandGroup("service").map((doc) => doc.name)).toContain("service logs");
    expect(commandGroup("server").map((doc) => doc.name)).toEqual([
      "server setup",
      "server status",
      "server start",
      "server stop",
      "server restart",
      "server logs",
      "server upgrade",
    ]);
    expect(commandGroup("login")).toEqual([]);
  });
});

describe("usageOf", () => {
  it("quotes the synopsis, one line per shape", () => {
    expect(usageOf("stop")).toBe(
      "usage: mend stop [session-id-prefix]\n       mend stop --all [--project <p>]",
    );
    expect(usageOf("doctor")).toBe("usage: mend doctor");
    expect(usageOf("unknown thing")).toBe("usage: mend unknown thing");
  });
});

describe("wrap", () => {
  it("breaks on words and keeps the indent", () => {
    expect(wrap("one two three four five", 22, 2)).toEqual(["  one two three four", "  five"]);
    expect(wrap("one two three four five", 22, 2, 4)).toEqual([
      "  one two three four",
      "      five",
    ]);
    expect(wrap("", 40)).toEqual([]);
  });
});

describe("renderIndex", () => {
  const index = renderIndex(80);

  it("lists every visible command under its section, sections in order", () => {
    const positions = SECTIONS.map((section) => index.indexOf(`\n${section}\n`));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect(positions).toEqual(positions.toSorted((a, b) => a - b));
    for (const doc of visible) expect(index, doc.name).toContain(`\n  ${doc.name} `);
    expect(index).not.toContain("  qr ");
  });

  it("aligns the summary column and never exceeds the width", () => {
    const rows = index.split("\n").filter((line) => /^ {2}\S/.test(line));
    const columns = new Set(rows.map((line) => line.search(/\S\s{2,}\S/)).filter((n) => n > 0));
    expect(columns.size).toBeGreaterThan(0);
    for (const line of index.split("\n")) expect(line.length, line).toBeLessThanOrEqual(80);
  });

  it("points at the per-command pages and the manual", () => {
    expect(index).toContain("mend help <command>");
    expect(index).toContain("man mend");
    expect(index).toContain("MEND_URL");
  });
});

describe("renderCommand", () => {
  it("prints usage, description, options, examples, and see also", () => {
    const page = renderCommand(findCommand(["codex"])!, 80);
    expect(page).toContain("mend codex · ");
    expect(page).toContain("\nusage\n");
    expect(page).toContain("also mend claude, mend opencode");
    expect(page).toContain("\noptions\n");
    expect(page).toContain("--effort <level>");
    expect(page).toContain("\nexamples\n");
    expect(page).toContain("\nsee also\n  mend attach");
    for (const line of page.split("\n")) expect(line.length, line).toBeLessThanOrEqual(80);
  });

  it("lists a family's subcommands on the parent page", () => {
    const page = renderCommand(findCommand(["ssh"])!, 80);
    expect(page).toContain("\nsubcommands\n");
    expect(page).toContain("ssh setup");
  });

  it("renders a group index for a family with no parent page", () => {
    expect(renderGroup("service", 80)).toContain("service restart");
    expect(renderGroup("login", 80)).toBeNull();
  });
});

describe("man pages", () => {
  it("documents offline flags and migration-safe recovery in the generated manual", () => {
    const setup = findCommand(["server", "setup"]);
    const upgrade = findCommand(["server", "upgrade"]);
    if (setup === null || upgrade === null) throw new Error("Server help missing");
    const page = renderManPage(setup, "0.23.0");
    expect(page).toContain("\\-\\-assets\\-dir");
    expect(page).toContain("assets");
    expect(page).toContain("offline");
    const recovery = renderManPage(upgrade, "0.23.0");
    expect(recovery).toContain("pg_dumpall");
    expect(recovery).toContain("never automatically downgrades or restores");
    for (const name of ["setup", "start", "restart", "upgrade"]) {
      const doc = findCommand(["server", name]);
      if (doc === null) throw new Error("Server help missing");
      const text = renderCommand(doc, 120).replace(/\s+/g, " ");
      expect(text).not.toContain("registry");
      expect(text).not.toContain("no GitHub requests or Docker pulls");
    }
  });
  it("escapes roff and names every page", () => {
    const page = renderManPage(findCommand(["service", "run"])!, "0.17.0");
    expect(page.startsWith('.TH MEND-SERVICE-RUN 1 "" "mend 0.17.0"')).toBe(true);
    expect(page).toContain(".SH SYNOPSIS");
    expect(page).toContain("\\-\\-port");
    expect(page).toContain("mend\\-service\\-init(1)");
  });

  it("escapes what roff would otherwise interpret", () => {
    expect(roff(".hidden")).toBe("\\&.hidden");
    expect(roff("'quoted")).toBe("\\&'quoted");
    expect(roff("--port <p>")).toBe("\\-\\-port <p>");
    expect(roff("a\\b")).toBe("a\\eb");
  });

  it("indexes every visible command in mend(1)", () => {
    const index = renderManIndex("0.17.0");
    for (const doc of visible)
      expect(index, doc.name).toContain(`.B mend ${doc.name.replace(/-/g, "\\-")}`);
    expect(index).not.toContain("mend qr");
  });
});
