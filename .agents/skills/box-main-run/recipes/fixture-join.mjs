// The second account joins the box's organization through an invitation link (fixtures.sh; the
// map's organization.md, "Join"). A fresh browser: run it with no --account. Inputs come from the
// environment; the password is read from its file and typed as a secret, never printed.
//
//   MAIN_RUN_JOIN_URL=<web>/join#<token> MAIN_RUN_JOIN_NAME=<name> MAIN_RUN_JOIN_EMAIL=<email> \
//   MAIN_RUN_JOIN_PASSWORD_FILE=<file> node .agents/skills/verify/scripts/drive-web.mjs --web $WEB \
//     --out <dir> --private $P2 --state $P2/browser.json \
//     --recipe .agents/skills/box-main-run/recipes/fixture-join.mjs
import { readFileSync } from "node:fs";

export default async ({ page, capture, note, typeSecret }) => {
  const {
    MAIN_RUN_JOIN_URL: url,
    MAIN_RUN_JOIN_NAME: name,
    MAIN_RUN_JOIN_EMAIL: email,
  } = process.env;
  const file = process.env.MAIN_RUN_JOIN_PASSWORD_FILE;
  if (!url || !name || !email || !file)
    throw new Error("the MAIN_RUN_JOIN_* variables are not all set");
  const password = readFileSync(file, "utf8").trim();
  await page.goto(url);
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await typeSecret(page.getByLabel("Password", { exact: true }), "second-password", password);
  await typeSecret(page.getByLabel("Password, again"), "second-password", password);
  await page.getByRole("button", { name: "Create account and join" }).click();
  await page.waitForURL(/\/welcome/);
  note(`joined as ${email}`);
  await capture("joined");
};
