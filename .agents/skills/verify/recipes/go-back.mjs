// Going back to a checkpoint (SLNT-1259): from the Change tab's range picker, then undone from the
// line it leaves in the conversation. The server saves the files first, puts them back, and takes
// a checkpoint after; every step is read back from the stack, never from the page alone.
// Run the CLI batch first, once per stack: two real `mend run` sessions in the worktree `go-back`.
// The first writes BACK.md "first"; the second rewrites it "second" and adds LATER.md.
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/go-back-sessions.json
//   pnpm verify drive web --recipe go-back
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/go-back-files.json
//
// The last batch prints the files as they stand after the undo: BACK.md "second" and LATER.md
// there. A local stack runs no agent, so the note an agent reads on its next message is the box's
// to show (flows.md `start-session.go-back`).

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

/** The one of a locator's matches a person sees: the desktop and phone layouts are both in the page. */
const visible = (locator) => locator.filter({ visible: true }).first();

const expectFiles = (seen, want, what) => {
  if (JSON.stringify(seen) !== JSON.stringify(want))
    throw new Error(
      `${what}: the stack reads ${JSON.stringify(seen)}, not ${JSON.stringify(want)}`,
    );
};

export default async ({ page, web, capture, note }) => {
  const settled = () => page.waitForTimeout(500);
  const setTheme = async (theme) => {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      theme === "dark",
    );
    await settled();
  };
  const hydrated = async () => {
    await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined);
    await page.waitForFunction(() =>
      [...document.querySelectorAll("a[href]")].some((link) =>
        Object.keys(link).some((key) => key.startsWith("__reactProps")),
      ),
    );
  };
  const open = async (path) => {
    await page.goto(`${web}${path}`);
    await hydrated();
  };
  const go = (path) => page.evaluate((to) => window["__TSR_ROUTER__"].navigate({ href: to }), path);
  /** The session's details as the stack answers them now. */
  const detailOf = (id) =>
    page.evaluate(async (sessionId) => {
      const { trpcClient } = window["__TSR_ROUTER__"].options.context;
      const detail = await trpcClient.sessions.detail.query({ id: sessionId });
      return {
        worktreeId: detail.session.worktreeId,
        checkpoints: detail.checkpoints.map((checkpoint) => ({
          id: checkpoint.id,
          ordinal: checkpoint.ordinal,
          sessionId: checkpoint.sessionId,
          trigger: checkpoint.trigger,
        })),
        restores: detail.restores.map((restore) => ({
          target: restore.target,
          saved: restore.saved,
          result: restore.result,
        })),
      };
    }, id);
  /** Which files differ between two checkpoints, as the stack reads them. */
  const between = (worktreeId, from, to) =>
    page.evaluate(
      async (input) => {
        const { trpcClient } = window["__TSR_ROUTER__"].options.context;
        const files = await trpcClient.worktrees.sliceFiles.query(input);
        return files.paths.toSorted();
      },
      { id: worktreeId, from, to },
    );
  await page.setViewportSize(DESKTOP);
  await open("/no-such-page");
  await page.evaluate(() => localStorage.setItem("mend-theme", "light"));

  // The batch's two sessions in `go-back`, the later one first.
  const ids = await page.evaluate(async () => {
    const { queryClient } = window["__TSR_ROUTER__"].options.context;
    await queryClient.refetchQueries({ queryKey: [["sessions", "inbox"]] });
    const rows =
      queryClient.getQueryCache().findAll({ queryKey: [["sessions", "inbox"]] })[0]?.state.data ??
      [];
    return rows
      .filter((row) => row.worktreeName === "go-back")
      .toSorted((a, b) => String(b.session.createdAt).localeCompare(String(a.session.createdAt)))
      .map((row) => row.session.id);
  });
  if (ids.length !== 2)
    throw new Error(`found ${ids.length} sessions in go-back: run the CLI batch once, first`);
  const [viewed, earlier] = ids;
  const before = await detailOf(viewed);
  if (before.restores.length !== 0)
    throw new Error("the worktree already went back once: run this on a fresh stack");
  const chain = before.checkpoints.toSorted((a, b) => a.ordinal - b.ordinal);
  const target = chain.filter((checkpoint) => checkpoint.sessionId === earlier).at(-1);
  const latest = chain.at(-1);
  if (target === undefined || latest === undefined || target.ordinal >= latest.ordinal)
    throw new Error(
      `the chain has no checkpoint of the first run before the second's: ${JSON.stringify(chain)}`,
    );
  note(
    `the worktree's checkpoints: ${chain.map((checkpoint) => `${checkpoint.ordinal} ${checkpoint.trigger}`).join(", ")}; going back to ${target.ordinal}, the first run's last`,
  );
  expectFiles(
    await between(before.worktreeId, target.id, latest.id),
    ["BACK.md", "LATER.md"],
    "the second run's changes",
  );

  // The range picker offers it; the dialog says what changes before anything does.
  const pickerOpen = async () => {
    await visible(page.getByRole("button", { name: /^Show changes:/ })).click();
  };
  await go(`/sessions/${viewed}/change`);
  await visible(page.getByRole("button", { name: /^Show changes:/ })).waitFor({ timeout: 60_000 });
  await settled();
  await pickerOpen();
  await page.getByRole("menuitem", { name: "Go back to a checkpoint…" }).click();
  const dialog = () => visible(page.getByRole("dialog"));
  await dialog().getByText("Go back to a checkpoint?").waitFor();
  await dialog().getByRole("combobox").selectOption(target.id);
  await dialog()
    .getByText(`go back to how they were at checkpoint ${target.ordinal}`, { exact: false })
    .waitFor();
  const asked = (await dialog().innerText()).replace(/\s+/g, " ");
  for (const want of [
    "Mend saves the files as they are now as a new checkpoint first, so you can undo this.",
    "Every session in this worktree uses these files. Each agent is told on its next message.",
    "The branch and its commits stay as they are.",
    "Cancel",
    "Go back",
  ])
    if (!asked.includes(want)) throw new Error(`the dialog reads "${asked}", without "${want}"`);
  note(`the dialog reads: "${asked}"`);
  for (const theme of ["light", "dark"]) {
    await setTheme(theme);
    await capture(`go-back-dialog-desktop-${theme}`);
  }
  await setTheme("light");
  await dialog().getByRole("button", { name: "Cancel" }).click();

  // At phone width the picker is a sheet with the same row, and the dialog a sheet of its own.
  await page.setViewportSize(PHONE);
  await settled();
  await pickerOpen();
  await visible(page.getByRole("button", { name: "Go back to a checkpoint…" })).click();
  await dialog().getByText("Go back to a checkpoint?").waitFor();
  const sideways = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (sideways) throw new Error("the page scrolls sideways at 390px with the dialog open");
  for (const theme of ["light", "dark"]) {
    await setTheme(theme);
    await capture(`go-back-dialog-phone-${theme}`);
  }
  await setTheme("light");
  await dialog().getByRole("button", { name: "Cancel" }).click();
  await page.setViewportSize(DESKTOP);
  await settled();

  // Go back: the toast names both checkpoints, and the stack holds the files as they were.
  await pickerOpen();
  await page.getByRole("menuitem", { name: "Go back to a checkpoint…" }).click();
  await dialog().getByRole("combobox").selectOption(target.id);
  await dialog().getByRole("button", { name: "Go back", exact: true }).click();
  const toast = page.getByText(`Went back to checkpoint ${target.ordinal}.`, { exact: false });
  await toast.waitFor({ timeout: 120_000 });
  const said = (await toast.innerText()).replace(/\s+/g, " ");
  note(`going back says: "${said}"`);
  await capture("go-back-done-desktop-light");
  const first = await detailOf(viewed);
  const [restore] = first.restores;
  if (restore === undefined || restore.target.ordinal !== target.ordinal)
    throw new Error(`the session's details list ${JSON.stringify(first.restores)}`);
  if (restore.saved.ordinal <= latest.ordinal || restore.result.ordinal <= restore.saved.ordinal)
    throw new Error(
      `the saved and result checkpoints are out of order: ${JSON.stringify(restore)}`,
    );
  expectFiles(
    await between(first.worktreeId, target.id, restore.result.id),
    [],
    "the files after going back, against the checkpoint gone back to",
  );
  expectFiles(
    await between(first.worktreeId, restore.saved.id, restore.result.id),
    ["BACK.md", "LATER.md"],
    "what going back changed, against the files saved first",
  );
  note(
    `the stack lists the restore: to ${restore.target.ordinal}, saved first as ${restore.saved.ordinal}, ${restore.result.ordinal} after; the files at ${restore.result.ordinal} match ${restore.target.ordinal}, and BACK.md and LATER.md differ from ${restore.saved.ordinal}`,
  );
  const triggers = Object.fromEntries(
    first.checkpoints.map((checkpoint) => [checkpoint.ordinal, checkpoint.trigger]),
  );
  if (
    triggers[restore.saved.ordinal] !== "restore-save" ||
    triggers[restore.result.ordinal] !== "restore"
  )
    throw new Error(`the new checkpoints read ${JSON.stringify(triggers)}`);

  // The conversation shows where it happened, and its details offer the undo.
  await go(`/sessions/${viewed}`);
  const line = () =>
    visible(page.getByRole("button", { name: `Went back to checkpoint ${target.ordinal}` }));
  await line().waitFor({ timeout: 30_000 });
  await line().hover();
  const details = () => visible(page.getByRole("dialog"));
  await details().getByText("Mend saved the files from just before", { exact: false }).waitFor();
  const words = (await details().innerText()).replace(/\s+/g, " ");
  for (const want of [
    `You put the files in this worktree back to how they were at checkpoint ${target.ordinal}.`,
    `Mend saved the files from just before as checkpoint ${restore.saved.ordinal}.`,
    "Each agent in this worktree is told on its next message.",
    `Go back to checkpoint ${restore.saved.ordinal}…`,
    "Open in Record",
  ])
    if (!words.includes(want))
      throw new Error(`the line's details read "${words}", without "${want}"`);
  note(`the line's details read: "${words}"`);
  for (const theme of ["light", "dark"]) {
    await setTheme(theme);
    await capture(`go-back-line-desktop-${theme}`);
  }
  await setTheme("light");
  await page.mouse.move(0, 0);
  await page.keyboard.press("Escape");

  await page.setViewportSize(PHONE);
  await settled();
  await line().click();
  await details().getByText("Mend saved the files from just before", { exact: false }).waitFor();
  for (const theme of ["light", "dark"]) {
    await setTheme(theme);
    await capture(`go-back-line-phone-${theme}`);
  }
  await setTheme("light");
  await page.keyboard.press("Escape");
  await page.setViewportSize(DESKTOP);
  await settled();

  // Undo: going back to the saved checkpoint puts the second run's files back.
  await line().click();
  await details()
    .getByRole("button", { name: `Go back to checkpoint ${restore.saved.ordinal}…` })
    .click();
  await dialog().getByText(`Go back to checkpoint ${restore.saved.ordinal}?`).waitFor();
  await capture("go-back-undo-dialog-desktop-light");
  await dialog().getByRole("button", { name: "Go back", exact: true }).click();
  await page
    .getByText(`Went back to checkpoint ${restore.saved.ordinal}.`, { exact: false })
    .waitFor({ timeout: 120_000 });
  const second = await detailOf(viewed);
  const undo = second.restores.at(-1);
  if (second.restores.length !== 2 || undo?.target.ordinal !== restore.saved.ordinal)
    throw new Error(`after the undo the details list ${JSON.stringify(second.restores)}`);
  expectFiles(
    await between(second.worktreeId, restore.saved.id, undo.result.id),
    [],
    "the files after the undo, against the files saved before going back",
  );
  await line().waitFor();
  await visible(
    page.getByRole("button", { name: `Went back to checkpoint ${restore.saved.ordinal}` }),
  ).waitFor({ timeout: 30_000 });
  await settled();
  note(
    `undone: went back to ${restore.saved.ordinal}; the files at ${undo.result.ordinal} match ${restore.saved.ordinal}, and the conversation shows both lines`,
  );
  for (const theme of ["light", "dark"]) {
    await setTheme(theme);
    await capture(`go-back-two-lines-desktop-${theme}`);
  }
  await setTheme("light");
};
