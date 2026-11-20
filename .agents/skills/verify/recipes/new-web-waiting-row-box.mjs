// A waiting session's row names what it waits on, on the box with a real Codex turn (SLNT-1178):
// Codex asks before a command, and the session's row under Waiting on you says "Wants to run rm -f
// …" in the sidebar, at phone width, in the project's Sessions tab and in the command palette, where
// a long command gives way to the title and its whole line shows on hover. After Approve the row
// leaves Waiting on you and the palette says the plain status again. Run it under your own hold:
//
//   pnpm verify drive new-web --box --recipe new-web-waiting-row-box
//
// The drive signs in as the box's checker account. The recipe starts one Codex session in
// verify-fixture from the New session composer with Ask before acting on and prints its id; stop
// it with the checker CLI before release. With full access, Codex asks only before a command it
// counts as dangerous, such as `rm -f`. A question, and a request that names nothing, can't be had
// on demand: new-web-waiting-row draws them locally from fixture answers.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const TURN_MS = 600_000;
/** A file name long enough that the command it is in has to give way in the palette. */
const FILE = "approval-check-for-the-waiting-row-in-the-new-web-app.txt";
const COMMAND = `rm -f ${FILE}`;
const PROMPT = `Run the shell command \`printf ok > ${FILE}\`, then delete the file by running exactly \`${COMMAND}\`. Reply with the single word deleted if the file is gone, or kept if the deletion didn't run.`;

const visible = (locator) => locator.filter({ visible: true }).first();

/** The text of a row's lines under its title, as a person reads them. */
const lines = async (locator) =>
  (await locator.innerText()).split("\n").slice(1).join(" | ").replace(/\s+/g, " ");

export default async ({ page, web, capture, note }) => {
  const settled = () => page.waitForTimeout(500);
  const inbox = () => page.getByRole("navigation", { name: "Inbox" }).filter({ visible: true });
  const waitingRow = (id) =>
    inbox()
      .getByRole("region", { name: "Waiting on you", exact: true })
      .locator(`a[href="/sessions/${id}"]`);
  const hydrated = () =>
    page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some((button) =>
        Object.keys(button).some((key) => key.startsWith("__reactProps")),
      ),
    );
  const call = (path, input, kind = "query") =>
    page.evaluate(
      async ({ path: route, input: value, kind: verb }) => {
        let target = window["__TSR_ROUTER__"].options.context.trpcClient;
        for (const part of route.split(".")) target = target[part];
        return target[verb](value);
      },
      { path, input, kind },
    );
  const palette = () => page.getByRole("dialog", { name: "Command palette" });
  const paletteResult = async (title) => {
    await page.keyboard.press("Control+k");
    await palette().getByRole("combobox").fill(title);
    const option = visible(palette().getByRole("option", { name: new RegExp(`^${title}`) }));
    await option.waitFor({ timeout: 30_000 });
    return option;
  };

  await page.setViewportSize(DESKTOP);
  await page.goto(`${web}/`);
  await visible(page.getByRole("heading", { name: "New session", exact: true })).waitFor();
  await hydrated();
  const pick = (name) => visible(page.getByRole("button", { name }));
  await pick(/^Project: /).click();
  await page.getByPlaceholder("Find a project").fill("verify-fixture");
  await page
    .getByRole("option", { name: /^verify-fixture/ })
    .first()
    .click();
  await pick(/^Agent and model: /).click();
  await page.getByRole("menuitemradio", { name: /^Codex/ }).click();
  const ask = page.getByRole("menuitemcheckbox", { name: "Ask before acting" });
  if ((await ask.getAttribute("aria-checked")) !== "true") await ask.click();
  await page.keyboard.press("Escape").catch(() => undefined);
  await visible(page.getByRole("textbox", { name: "Task" })).fill(PROMPT);
  await visible(page.getByRole("button", { name: "Start session" })).click();
  await page.waitForURL(/\/sessions\/[0-9a-f-]+$/, { timeout: 120_000 });
  const id = new URL(page.url()).pathname.split("/").at(-1);
  note(`started session ${id} with Ask before acting; stop it with the checker CLI before release`);

  // Codex asks before the delete: the row moves under Waiting on you and names the command.
  await visible(page.getByText(/^Codex wants to run a command$/)).waitFor({ timeout: TURN_MS });
  const row = waitingRow(id).first();
  await row.waitFor({ timeout: 60_000 });
  await row.getByText(`Wants to run ${COMMAND}`, { exact: false }).waitFor({ timeout: 60_000 });
  note(`sidebar: the row reads "${await lines(row)}"`);
  await capture("box-sidebar-waiting-desktop-light");

  // The command palette: the status names the command, cut to leave the title whole.
  const rows = await call("sessions.inbox");
  const title = rows.find((each) => each.session.id === id)?.title;
  if (title === undefined) throw new Error(`the inbox read has no row for ${id}`);
  const option = await paletteResult(title);
  const status = option.locator("[data-slot=status]");
  const shown = await status.getAttribute("title");
  const fits = await status.evaluate((node) => {
    const words = node.firstElementChild;
    return words instanceof HTMLElement && words.scrollWidth > words.clientWidth;
  });
  note(`palette: ${title}'s status title reads "${shown}"; cut with an ellipsis: ${fits}`);
  if (shown !== `Wants to run ${COMMAND}`) throw new Error(`the palette's status reads ${shown}`);
  await capture("box-palette-waiting-desktop-light");
  await page.keyboard.press("Escape");

  // The project's Sessions tab.
  const project = (await call("projects.list")).find((each) => each.name === "verify-fixture");
  await page.goto(`${web}/projects/${project.id}`);
  await hydrated();
  await visible(page.getByRole("main").getByText(`Wants to run ${COMMAND}`)).waitFor({
    timeout: 60_000,
  });
  note("project Sessions tab: the session's row names the command");
  await capture("box-project-sessions-waiting-desktop-light");

  // A phone: the row's second line names it too.
  await page.setViewportSize(PHONE);
  await page.goto(`${web}/`);
  await hydrated();
  await visible(
    page.locator(`a[href="/sessions/${id}"]`).getByText(`Wants to run ${COMMAND}`),
  ).waitFor({ timeout: 60_000 });
  note("phone: the session's row names the command");
  await capture("box-inbox-waiting-phone-light");
  await page.setViewportSize(DESKTOP);

  // Approve: the row leaves Waiting on you, and the palette says the plain status.
  await page.goto(`${web}/sessions/${id}`);
  await hydrated();
  await visible(page.getByRole("button", { name: "Approve", exact: true })).click();
  await visible(page.getByText(/^Codex wants to run a command$/)).waitFor({
    state: "hidden",
    timeout: 60_000,
  });
  await waitingRow(id).first().waitFor({ state: "detached", timeout: 60_000 });
  note("Approve: the row left Waiting on you with no reload");
  const after = await paletteResult(title);
  const word = await after.locator("[data-slot=status]").innerText();
  note(`palette after Approve: ${title}'s status reads "${word}"`);
  if (word.startsWith("Wants to")) throw new Error("the palette still names the request");
  await settled();
  await capture("box-palette-after-approve-desktop-light");
  await page.keyboard.press("Escape");
};
