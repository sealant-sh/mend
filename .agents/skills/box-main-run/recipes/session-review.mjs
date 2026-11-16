// A session's change, opened as a person does from the Now inbox, on the box (flows.md:
// review-change.web-review, server.data-intact). The session is $MAIN_RUN_SESSION; its change holds
// MAIN-RUN.md with the line `seen`. The row's context menu carries `Open review` (the session page
// lost its `Review the change` link in #1390); a settled session's row is under the `Settled` fold.
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
  await page.waitForURL(/\/changes\//);
  const main = page.getByRole("main");
  await main.getByText("MAIN-RUN.md").first().waitFor();
  await main.getByText("seen", { exact: true }).first().waitFor();
  note(
    `Open review on ${id.slice(0, 8)}'s row opened ${new URL(page.url()).pathname}: MAIN-RUN.md with the line seen`,
  );
  await capture("review");
};
