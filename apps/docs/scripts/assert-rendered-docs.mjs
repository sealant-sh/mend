import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const installPage = await readFile(
  new URL("../dist/getting-started/install/index.html", import.meta.url),
  "utf8",
);

const networkBoundary = installPage.indexOf('id="network-boundary"');
const createAccount = installPage.indexOf('id="create-your-mend-account"');

assert.notEqual(networkBoundary, -1, "Install page must explain its network boundary");
assert.notEqual(createAccount, -1, "Install page must explain account creation");
assert.ok(networkBoundary < createAccount, "Install page must state network risk before sign-up");
for (const section of ["install-only-the-cli", "set-up-the-server", "operate-and-upgrade"]) {
  assert.ok(installPage.includes(`id="${section}"`), `Install page must explain ${section}`);
}
assert.ok(!installPage.includes("MEND_ALLOW_MACOS"), "Do not document the retired macOS bypass");
assert.ok(!installPage.includes("SEALANT_VERSION=latest"), "Users select only a Mend version");

const homePage = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
for (const section of [
  "introduction",
  "what-mend-puts-in-one-place",
  "quick-look",
  "workspaces-that-match-the-project",
  "get-started",
  "learn-the-system",
]) {
  assert.ok(homePage.includes(`id="${section}"`), `Home page must render its ${section} section`);
}
assert.ok(
  (homePage.match(/class="mermaid"/g) ?? []).length >= 2,
  "Home page must render its deployment and session diagrams",
);
assert.ok(
  !homePage.includes('class="landing-hero'),
  "Home page must use the documentation layout rather than a custom marketing hero",
);
assert.ok(!homePage.includes(" :::"), "Rendered pages must not expose directive markers");
assert.ok(homePage.includes("mend server setup"), "Home page must point at explicit server setup");
assert.ok(
  !homePage.includes("The installer sets up Mend and Sealant"),
  "Home page must not describe the retired host-process installer",
);

const cliPage = await readFile(
  new URL("../dist/reference/cli/index.html", import.meta.url),
  "utf8",
);
for (const section of ["server-commands", "workspace-ssh-commands", "skills-commands"]) {
  assert.ok(cliPage.includes(`id="${section}"`), `CLI reference must document ${section}`);
}
assert.ok(
  !cliPage.includes("Adopt a local path"),
  "CLI reference must not offer local-path adoption",
);

const workspaceImagesPage = await readFile(
  new URL("../dist/guides/workspace-images/index.html", import.meta.url),
  "utf8",
);
const workspaceImagesText = workspaceImagesPage.replace(/\s+/g, " ");
assert.ok(
  workspaceImagesText.includes("isolation and privilege model depend on the workspace runtime"),
  "Workspace image docs must describe Docker privilege as runtime-specific",
);
assert.ok(
  !workspaceImagesText.includes("disposable rootless daemon"),
  "Workspace image docs must not promise a rootless daemon on every runtime",
);
assert.ok(
  workspaceImagesText.includes("does not retrofit a workspace that is already running or retained"),
  "Workspace image docs must explain Docker behavior when a session reuses its workspace",
);

process.stdout.write("Rendered docs structure is valid\n");
