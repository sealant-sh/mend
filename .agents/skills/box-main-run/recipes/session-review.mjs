// A session's change, opened as a person does from the Now inbox, on the box (flows.md:
// review-change.web-review, server.data-intact). The session is $MAIN_RUN_SESSION; its change holds
// MAIN-RUN.md with the line `seen`. The row's context menu carries `Open review` (the session page
// lost its `Review the change` link in #1390); a settled session's row is under the `Settled` fold.
// `/changes/<id>` lands on `/sessions/<id>/change`. The diff's file is the region named by its path,
// (outside the `main` landmark) holding the button `MAIN-RUN.md +<n>` and the added lines as
// `code`; the page also keeps the
// prompt, which names MAIN-RUN.md, in a hidden conversation bubble, so the recipe reads only inside
// that region.
//
//   MAIN_RUN_SESSION=<id> node .agents/skills/verify/scripts/drive-web.mjs --web $WEB --out <dir> \
//     --private $P --account $P/account.json --state $P/browser.json \
//     --recipe .agents/skills/box-main-run/recipes/session-review.mjs
import { inboxRow } from "./inbox.lib.mjs";

export default async ({ page, web, capture, note }) => {
  const id = process.env.MAIN_RUN_SESSION;
  if (!id) throw new Error("MAIN_RUN_SESSION is not set");
  const row = await inboxRow(page, web, id, note);
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open review", exact: true }).click();
  await page.waitForURL(/\/changes?(\/|$)/);
  const file = page.getByRole("region", { name: "MAIN-RUN.md", exact: true });
  await file.getByRole("button", { name: /^MAIN-RUN\.md \+\d+$/ }).waitFor();
  const added = file.getByRole("code").filter({ hasText: "seen" }).first();
  // The diff's code element is laid out but does not count as visible to Playwright: wait for it to
  // be in the page and read its text.
  await added.waitFor({ state: "attached" });
  const lines = ((await added.textContent()) ?? "").replace(/\s+/g, " ").trim();
  note(
    `Open review on ${id.slice(0, 8)}'s row opened ${new URL(page.url()).pathname}: the diff's MAIN-RUN.md reads ${lines}`,
  );
  await capture("review");
};
