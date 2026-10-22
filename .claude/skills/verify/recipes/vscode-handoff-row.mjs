// Needs a server with #1106 (`mend handoff` received as a worktree and session).

import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const world = await import(
  pathToFileURL(join(import.meta.dirname, "../../../../scripts/vscode-remote-world.mjs")).href
);

const BRANCH = `verify-handoff-${Date.now().toString(36)}`;
const HANDED_OFF = /^idle · handed off from (.+)$/;

const expect = (holds, message) => {
  if (!holds) throw new Error(message);
};

export default async (h) => {
  const {
    page,
    palette,
    view,
    viewRows,
    treeItem,
    waitUntil,
    shot,
    step,
    note,
    api,
    state,
    sleep,
  } = h;
  const project = state.project;
  const env = { ...process.env, HOME: state.home, XDG_CONFIG_HOME: state.configHome };
  const git = (args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Dana",
        "-c",
        "user.email=dana@verify.invalid",
        "-C",
        state.checkout,
        ...args,
      ],
      { env, encoding: "utf8" },
    ).trim();

  const openProjectRows = async () => {
    await view("Mend");
    await waitUntil(
      "the Mend view's first rows",
      async () => ((await viewRows()).rows.some((one) => one.label === "Projects") ? true : null),
      120_000,
    );
    for (const label of ["Projects", project.name]) {
      const row = (await viewRows()).rows.find((one) => one.label === label);
      if (row?.expanded === "false") {
        await treeItem(label).click();
        await waitUntil(
          `${label} open`,
          async () =>
            (await viewRows()).rows.find((one) => one.label === label)?.expanded === "true"
              ? true
              : null,
          15_000,
        );
      }
    }
  };

  await step(
    "the window reloaded, so it runs the extension as built now",
    async () => {
      await palette("Developer: Reload Window").catch((error) => {
        if (!String(error?.message).includes("the palette to close")) throw error;
        note(
          `the reload outran the palette's close check: ${String(error.message).split("\n")[0]}`,
        );
      });
      await page().locator(".monaco-workbench").first().waitFor({ timeout: 120_000 });
      await sleep(3_000);
      await openProjectRows();
      return "the Mend view after the reload";
    },
    { via: "setup" },
  );

  const before = await step(
    "Mend's read before the handoff: the project's worktrees",
    async () => {
      const read = await api(`/projects/${project.id}`);
      return {
        observed: `${read.worktrees.length} worktrees · ${read.sessions.length} sessions`,
        worktrees: read.worktrees.map((one) => one.id),
      };
    },
    { via: "api" },
  );

  const start = git(["branch", "--show-current"]) || git(["rev-parse", "HEAD"]);
  try {
    await step(
      `a commit on ${BRANCH} and one edit left uncommitted in the window's checkout`,
      async () => {
        git(["switch", "-q", "-c", BRANCH]);
        writeFileSync(join(state.checkout, "login.txt"), "redirect to /home after sign-in\n");
        git(["add", "login.txt"]);
        git(["commit", "-q", "-m", "fix the login redirect"]);
        appendFileSync(join(state.checkout, "README"), "\nstill editing\n");
        return `HEAD ${git(["rev-parse", "--short", "HEAD"])} · status ${JSON.stringify(git(["status", "--short"]))}`;
      },
      { via: "setup" },
    );

    const handoff = await step(
      "mend handoff --yes in the checkout",
      async () => {
        const ran = await world.cli(["handoff", "--yes"], env, {
          cwd: state.checkout,
          allowFailure: true,
        });
        const said = `${ran.stdout.trim()}${ran.stderr.trim() === "" ? "" : ` · stderr ${ran.stderr.trim()}`}`;
        expect(ran.status === 0, `mend handoff exited ${ran.status}: ${said}`);
        return { observed: `exit 0 · ${said}` };
      },
      { via: "setup" },
    );

    const received = await step(
      "Mend's read: one new worktree with where it came from, and its session",
      async () => {
        const read = await api(`/projects/${project.id}`);
        const worktree = read.worktrees.find(
          (one) => !before.worktrees.includes(one.id) && one.handoff !== null,
        );
        expect(worktree !== undefined, `no new handed-off worktree after ${handoff.observed}`);
        const session = read.sessions.find((one) => one.worktreeId === worktree.id);
        expect(session !== undefined, `no session in the worktree ${worktree.name}`);
        return {
          observed: `worktree "${worktree.name}" · handoff.machine "${worktree.handoff.machine}" · cutAt ${worktree.handoff.cutAt} · session ${session.id.slice(0, 8)} label ${JSON.stringify(session.label)} ${session.status}`,
          name: worktree.name,
          machine: worktree.handoff.machine,
          sessionId: session.id,
        };
      },
      { via: "api" },
    );

    const row = await step(
      "the row: the worktree's name, `idle · handed off from <machine>` once the hold settles",
      async () => {
        await openProjectRows();
        const seen = [];
        const settled = await waitUntil(
          `the row ${received.name} reads idle · handed off from …`,
          async () => {
            const found = (await viewRows()).rows.find((one) => one.label === received.name);
            const description = found?.description ?? null;
            if (description !== null && seen.at(-1) !== description) seen.push(description);
            return description !== null && HANDED_OFF.test(description) ? found : null;
          },
          600_000,
        );
        await shot("handoff-row");
        const machine = HANDED_OFF.exec(settled.description)?.[1] ?? "";
        const observed = `row "${settled.label}" "${settled.description}" · descriptions seen ${JSON.stringify(seen)}`;
        expect(settled.label === received.name, observed);
        return { observed, machine };
      },
    );

    await step("the row's tooltip says where it came from", async () => {
      const tooltip = await treeItem(received.name).tooltip();
      await shot("handoff-row-tooltip");
      const observed = `tooltip ${JSON.stringify(tooltip)}`;
      expect(tooltip.includes(`handed off from ${received.machine}`), observed);
      return observed;
    });

    await step(
      "the machine the row names is the worktree's handoff.machine in Mend's read",
      async () => {
        const read = await api(`/projects/${project.id}`);
        const worktree = read.worktrees.find((one) => one.name === received.name);
        const observed = `row machine "${row.machine}" · handoff.machine "${worktree?.handoff?.machine}"`;
        expect(worktree?.handoff?.machine === row.machine, observed);
        return observed;
      },
      { via: "api" },
    );
  } finally {
    await step(
      "the checkout back where it started: the edit discarded, the branch deleted",
      async () => {
        if (git(["branch", "--show-current"]) === BRANCH) git(["reset", "-q", "--hard"]);
        git(["checkout", "-q", start]);
        if (git(["branch", "--list", BRANCH]) !== "") git(["branch", "-q", "-D", BRANCH]);
        return `on ${git(["branch", "--show-current"]) || git(["rev-parse", "--short", "HEAD"])} · status ${JSON.stringify(git(["status", "--short"]))} · ${BRANCH} ${git(["branch", "--list", BRANCH]) === "" ? "deleted" : "still there"}`;
      },
      { via: "setup" },
    );
  }
};
