// A session's page and its change, on the box (flows.md: data-intact, web-review). The session is
// $MAIN_RUN_SESSION; its change holds MAIN-RUN.md with the line `seen`.
//
//   MAIN_RUN_SESSION=<id> node .agents/skills/verify/scripts/drive-web.mjs --web $WEB --out <dir> \
//     --private $P --account $P/account.json --state $P/browser.json \
//     --recipe .agents/skills/box-main-run/recipes/session-review.mjs
export default async ({ page, web, capture, note }) => {
  const id = process.env.MAIN_RUN_SESSION;
  if (!id) throw new Error("MAIN_RUN_SESSION is not set");
  await page.goto(`${web}/sessions/${id}`);
  const main = page.getByRole("main");
  await main.getByRole("heading").first().waitFor();
  note(`the session page of ${id.slice(0, 8)} loads`);
  await capture("session");
  await page.getByRole("link", { name: "Review the change" }).click();
  await page.waitForURL(/\/changes\//);
  await page.getByRole("button", { name: /^▶\s*MAIN-RUN\.md/ }).waitFor();
  await main.getByText("seen", { exact: true }).first().waitFor();
  note(`its review at ${new URL(page.url()).pathname} shows MAIN-RUN.md with the line seen`);
  await capture("review");
};
