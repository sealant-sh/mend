// The second account approves its own CLI's sign-in (fixtures.sh; the map's sign-in.md,
// "Authorize"). Run it with that account's --account file, never the first account's.
//
//   MAIN_RUN_AUTHORIZE_URL=<web>/authorize?code=<code> node .agents/skills/verify/scripts/drive-web.mjs \
//     --web $WEB --out <dir> --private $P2 --account $P2/account.json --state $P2/browser.json \
//     --recipe .agents/skills/box-main-run/recipes/fixture-authorize.mjs
export default async ({ page, capture, note }) => {
  const url = process.env.MAIN_RUN_AUTHORIZE_URL;
  if (!url) throw new Error("MAIN_RUN_AUTHORIZE_URL is not set");
  await page.goto(url);
  await page.getByRole("heading", { name: "Authorize this terminal?" }).waitFor();
  await page.getByRole("button", { name: "Authorize", exact: true }).click();
  await page.getByRole("heading", { name: "Authorized" }).waitFor();
  note("the second account authorized its CLI");
  await capture("authorized");
};
