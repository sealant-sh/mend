// The sidebar's Inbox lists this run's session, on the box (flows.md: web-now). The session is
// $MAIN_RUN_SESSION.
//
//   MAIN_RUN_SESSION=<id> node .agents/skills/verify/scripts/drive-web.mjs ... \
//     --recipe .agents/skills/box-main-run/recipes/now.mjs
//
// The Inbox is the navigation "Inbox", in groups (apps/web/src/lib/inbox.ts INBOX_GROUPS). Each
// group folds under its heading, and each browser keeps which are open, so a folded group draws no
// rows: the recipe opens each folded group, then each "Show N more", until the row is there.
const GROUPS = ["Waiting on you", "To review", "Running", "Snoozed", "Done"];

export default async ({ page, web, capture, note }) => {
  const id = process.env.MAIN_RUN_SESSION;
  if (!id) throw new Error("MAIN_RUN_SESSION is not set");
  await page.goto(`${web}/`);
  const inbox = page.getByRole("navigation", { name: "Inbox" });
  await inbox.waitFor();
  const row = inbox.locator(`a[href$="/sessions/${id}"]`).first();
  const opened = [];
  for (const label of GROUPS) {
    if ((await row.count()) > 0) break;
    const group = inbox.getByRole("region", { name: label, exact: true });
    if ((await group.count()) === 0) continue;
    // The heading is the group's first button: its name, its count and the fold.
    const heading = group.getByRole("button").first();
    if ((await heading.getAttribute("aria-expanded")) === "false") {
      await heading.click();
      opened.push(label);
    }
    const more = group.getByRole("button", { name: /^Show \d+ more$/ });
    while ((await row.count()) === 0 && (await more.count()) > 0) await more.first().click();
  }
  if (opened.length > 0) note(`opened the folded groups ${opened.join(", ")}`);
  await row.waitFor({ timeout: 20_000 });
  const group = await row.evaluate((link) => link.closest("section")?.getAttribute("aria-label"));
  note(
    `the Inbox has a row linking to ${id.slice(0, 8)} under ${group ?? "no group"}: ${JSON.stringify((await row.innerText()).trim())}`,
  );
  await capture("now");
};
