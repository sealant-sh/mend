// Two things a person reading a change in the web app's review must be able to do, each
// checked by what the page draws, not by a picture alone (SLNT-1236, after the owner found both
// broken on his server and the daily run had seen neither):
//
// - The diff's code shows syntax colours. In `src/payments/retry.ts` the keyword `import`, the
//   string `"./charge"` and the plain name `lastError` are drawn in three different colours, read
//   from the rendered tokens' computed colour in the renderer's shadow root, in light and dark.
// - Picking a range that holds no change keeps the range picker. "Up to a checkpoint" with a
//   checkpoint that holds the base's files shows an empty state under the toolbar, worded for the
//   range ("Nothing changed up to checkpoint N"), and the picker then goes back to the whole change.
//
// Run the Change view's CLI batch first, once per stack (its worktree `change-small` is the change
// read here; its first checkpoints hold the base's files):
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/change-sessions.json
//   pnpm verify drive web --recipe review-reads
//
// The daily run of main drives it as the flow `review-change.new-web-review-reads`.
import { existsSync } from "node:fs";
import { join } from "node:path";

const DESKTOP = { width: 1280, height: 900 };
const RETRY = "src/payments/retry.ts";

/** The first of `locator`'s matches a person can see: under 1024px every tab is in the page twice. */
const visible = (locator) => locator.filter({ visible: true }).first();

export default async ({ page, web, capture: captureOnce, note }) => {
  const out = process.argv[process.argv.indexOf("--out") + 1] ?? "";
  const settled = () => page.waitForTimeout(500);
  const setTheme = async (theme) => {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      theme === "dark",
    );
    await settled();
  };
  /** How many times the page's DOM gained or lost nodes in one second. */
  const changesInASecond = () =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          let changes = 0;
          const observer = new MutationObserver((records) => {
            changes += records.length;
          });
          observer.observe(document.body, { childList: true, subtree: true });
          setTimeout(() => {
            observer.disconnect();
            resolve(changes);
          }, 1_000);
        }),
    );
  const still = async () => {
    for (let second = 0; second < 10; second += 1) if ((await changesInASecond()) === 0) return;
  };
  // The driver withholds a picture when the page changes while it looks: look again until it keeps one.
  const capture = async (name) => {
    await page.mouse.move(1, 1);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await still();
      await captureOnce(name);
      if (existsSync(join(out, `${name}.png`))) return;
      await page.waitForTimeout(600);
    }
  };
  const hydrated = async () => {
    await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined, null, {
      timeout: 90_000,
    });
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("a[href], button")].some((element) =>
          Object.keys(element).some((key) => key.startsWith("__reactProps")),
        ),
      null,
      { timeout: 90_000 },
    );
  };
  const open = async (path) => {
    await page.goto(`${web}${path}`);
    await hydrated();
    // The dev server may reload the page once as it bundles a module it hadn't seen.
    await page.waitForTimeout(1_500);
    await hydrated();
  };
  const client = (fn, arg) =>
    page.evaluate(
      async ([source, value]) => {
        const trpc = window["__TSR_ROUTER__"].options.context.trpcClient;
        // eslint-disable-next-line no-new-func
        return new Function("trpc", "value", `return (${source})(trpc, value)`)(trpc, value);
      },
      [fn.toString(), arg],
    );
  const section = (file) => visible(page.locator(`section[data-file="${file}"]`));
  const rangeChip = () => visible(page.getByRole("button", { name: /^Show changes: / }));
  const chipWords = async () => (await rangeChip().getAttribute("aria-label")) ?? "";
  const menu = visible(page.getByRole("menu"));

  /**
   * The colour each token of `file`'s drawn lines is painted in, by its text: the renderer draws
   * in a shadow root, so this reads the computed colour there. The first token with a given text
   * wins.
   */
  const tokenColours = (file) =>
    page.evaluate((path) => {
      const host = document.querySelector(
        `section[data-file="${CSS.escape(path)}"] diffs-container`,
      );
      const root = host?.shadowRoot;
      if (root == null) return null;
      const colours = {};
      for (const row of root.querySelectorAll("[data-line]"))
        for (const span of row.querySelectorAll("span")) {
          if (span.children.length > 0) continue;
          const text = (span.textContent ?? "").trim();
          if (text === "" || text in colours) continue;
          colours[text] = getComputedStyle(span).color;
        }
      return colours;
    }, file);

  // Both checks run on every drive: a failure is noted at once and the drive fails at the end.
  const failures = [];
  const fail = (words) => {
    failures.push(words);
    note(`FAILED: ${words}`);
  };

  /** Fails unless `import`, the string and a plain name each have a colour of their own. */
  const coloured = async (theme) => {
    let colours = null;
    // Highlighting arrives a moment after the lines: a grammar loads the first time it is used.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      colours = await tokenColours(RETRY);
      const string = Object.keys(colours ?? {}).find((text) => text.includes("./charge"));
      if (colours !== null && colours["import"] !== undefined && string !== undefined) break;
      await page.waitForTimeout(500);
    }
    if (colours === null) return fail(`${RETRY}'s lines aren't drawn`);
    const keyword = colours["import"];
    const stringText = Object.keys(colours).find((text) => text.includes("./charge"));
    const string = stringText === undefined ? undefined : colours[stringText];
    const plain = colours["lastError"];
    if (keyword === undefined || string === undefined || plain === undefined)
      return fail(
        `${theme}: the tokens import, "./charge" and lastError aren't all drawn as their own spans (${Object.keys(colours).length} tokens read)`,
      );
    const distinct = new Set(Object.values(colours)).size;
    const said = `${theme}: import ${keyword}, "./charge" ${string}, lastError ${plain}; ${distinct} colours across ${Object.keys(colours).length} tokens`;
    if (keyword === plain || string === plain || keyword === string)
      return fail(`no syntax colours in the diff: ${said}`);
    note(`syntax colours in ${RETRY}, ${said}`);
  };

  await page.setViewportSize(DESKTOP);
  await open("/no-such-page");
  await page.evaluate(() => localStorage.setItem("mend-theme", "light"));

  const rows = await page.evaluate(async () => {
    const queryClient = window["__TSR_ROUTER__"].options.context.queryClient;
    await queryClient.refetchQueries({ queryKey: [["sessions", "inbox"]] });
    return queryClient.getQueryCache().findAll({ queryKey: [["sessions", "inbox"]] })[0]?.state
      .data;
  });
  if (!Array.isArray(rows)) throw new Error("the page holds no inbox read");
  const [small] = rows
    .filter((row) => row.worktreeName === "change-small")
    .toSorted((a, b) => String(a.session.createdAt).localeCompare(String(b.session.createdAt)))
    .map((row) => row.session);
  if (small === undefined) throw new Error("run change-sessions.json first");
  const detail = await client(async (trpc, id) => trpc.sessions.detail.query({ id }), small.id);
  if (detail.change === null) throw new Error("change-small has no change");
  const chain = detail.checkpoints
    .filter((each) => each.ordinal > 0)
    .toSorted((a, b) => a.ordinal - b.ordinal);
  const latest = chain.at(-1)?.ordinal ?? 0;
  note(`change-small's worktree has checkpoints 1 to ${latest}`);
  // Start clean: the whole change, a fresh review, Unified.
  await page.context().clearCookies({ name: "mend-tiles" });
  await page.context().clearCookies({ name: "mend-diff-layout" });
  await page.evaluate(() => sessionStorage.clear());

  // The diff's code is coloured, in light and dark.
  await open(`/sessions/${small.id}/change`);
  await section(RETRY).locator("diffs-container").waitFor({ timeout: 60_000 });
  for (const theme of ["light", "dark"]) {
    await setTheme(theme);
    await coloured(theme);
    await capture(`code-colours-${theme}`);
  }
  await setTheme("light");

  // Up to a checkpoint that holds the base's files: the picker stays, and goes back.
  // The first checkpoint is taken as the first session starts, before it writes a file.
  const wholeWords = await chipWords();
  const empty = chain[0];
  if (empty === undefined || empty.ordinal === latest)
    throw new Error("change-small has no checkpoint before its last: run the batch again");
  await rangeChip().click();
  await menu.waitFor();
  await visible(menu.getByRole("menuitem", { name: new RegExp(`^${empty.ordinal} · `) })).click();
  await menu.waitFor({ state: "hidden" });
  // The range's diffs or an empty state, once the review over the range is read.
  const shown = await page
    .waitForFunction(
      (ordinal) => {
        const said = [...document.querySelectorAll("div[data-slot=empty]")].some((each) =>
          /(No changes yet|Nothing changed)/.test(each.textContent ?? ""),
        );
        if (said) return "empty";
        const upTo = [...document.querySelectorAll("button")].some((each) =>
          (each.getAttribute("aria-label") ?? "").includes(`Up to checkpoint ${ordinal}`),
        );
        return upTo && document.querySelector("section[data-file]") !== null ? "diffs" : false;
      },
      empty.ordinal,
      { timeout: 30_000 },
    )
    .then((handle) => handle.jsonValue())
    .catch(() => null);
  if (shown !== "empty")
    throw new Error(
      `up to checkpoint ${empty.ordinal} shows ${shown ?? "nothing"}, not an empty range: run the batch on a fresh stack`,
    );
  await settled();
  const title = await visible(page.getByText(/^(No changes yet|Nothing changed)/)).innerText();
  const pickerStays = await rangeChip()
    .isVisible()
    .catch(() => false);
  for (const theme of ["light", "dark"]) {
    await setTheme(theme);
    await capture(`empty-range-${theme}`);
  }
  await setTheme("light");
  if (title !== `Nothing changed up to checkpoint ${empty.ordinal}`)
    fail(
      `up to checkpoint ${empty.ordinal} reads "${title}", not "Nothing changed up to checkpoint ${empty.ordinal}"`,
    );
  if (!pickerStays)
    fail(
      `up to checkpoint ${empty.ordinal} reads "${title}" and the range picker is gone: there is no way back`,
    );
  else {
    note(
      `Up to checkpoint ${empty.ordinal}: "${title}" under the toolbar, and the picker reads "${await chipWords()}"`,
    );
    // Back through the picker, not the empty state's button.
    await rangeChip().click();
    await menu.waitFor();
    await visible(menu.getByRole("menuitem", { name: /^Whole change/ })).click();
    await section(RETRY).waitFor({ timeout: 60_000 });
    const back = await chipWords();
    if (back !== wholeWords) fail(`the picker went back to "${back}", not "${wholeWords}"`);
    else note(`the picker went back to the whole change: "${back}"`);
    await capture("back-to-whole-light");
  }
  if (failures.length > 0) throw new Error(failures.join("; "));
};
