// The projects page, signed in as the stack's first account: the page loads with its heading and
// lists the fixture project Launch adopted. The smallest web recipe, and the shape of every other
// (SKILL.md, Drive):
//
//   pnpm verify drive web --recipe web-projects
//   node .agents/skills/verify/scripts/drive-web.mjs --web "$web" --out <dir> --private "$P" \
//     --recipe .agents/skills/verify/recipes/web-projects.mjs --account "$P/account.json" \
//     --state "$P/browser.json"
export default async ({ page, web, capture, note }) => {
  await page.goto(`${web}/projects`);
  const main = page.getByRole("main");
  await main.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  await main.getByText("verify-fixture").first().waitFor();
  note("the projects page lists verify-fixture");
  await capture("projects");
};
