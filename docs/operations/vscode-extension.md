# Publishing the VS Code extension

The extension in `apps/vscode` is published as `sealant-sh.mend` to the
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=sealant-sh.mend) and
[Open VSX](https://open-vsx.org/extension/sealant-sh/mend) (which VSCodium, Cursor and other VS Code
builds install from). The workflow is `.github/workflows/publish-vscode.yml`. It packages the
extension with no credential in reach, publishes the `.vsix` to both registries from the
`vscode-marketplace` environment after an approval, and attaches the same `.vsix` to a
`vscode-vX.Y.Z` GitHub release.

## Versions

The extension's version follows the Mend release it needs: `0.36.x` works with a Mend 0.36 server.
The minor moves with Mend's minor; the patch is the extension's own, so an extension-only fix is
`0.36.1` whether or not Mend has a `0.36.1`. The Marketplace takes `X.Y.Z` only, so the extension
has no `-next.N` builds; a preview of it is a `.vsix` from the workflow's pull request run.

`apps/vscode` is a private package, and `.changeset/config.json` keeps private packages out of
versioning (`privatePackages.version: false`), so the Version Packages pull request never touches
it. A release of the extension is its own pull request: bump `version` in `apps/vscode/package.json`
and add a `## X.Y.Z` section to `apps/vscode/CHANGELOG.md`. The workflow refuses a version without
that section, a tag that does not match `package.json`, and a commit that is not on main.

The tags do not collide with Mend's: `release-cli.yml` ignores `vscode-v*`, and the next-version and
release-pin scripts read only `vX.Y.Z` and `vX.Y.Z-next.N` tags.

## One-time setup (the owner)

Every step needs an account only the owner holds. Nothing here is automated.

1. **Marketplace publisher.** Sign in at <https://marketplace.visualstudio.com/manage> with the
   Microsoft account that will own the extension, choose **Create publisher**, and enter ID
   `sealant-sh` (it must equal `publisher` in `apps/vscode/package.json` and cannot be changed
   later) and name `Sealant`.
2. **Azure DevOps token.** At <https://dev.azure.com>, signed in with the same Microsoft account
   (create an organization if it asks for one), open **User settings → Personal access tokens → New
   Token**. Set **Organization** to **All accessible organizations** (a single organization makes
   the Marketplace answer 401/403), **Scopes** to **Custom defined → Show all scopes → Marketplace →
   Manage**, and an expiry. Copy the token. Check it with `npx @vscode/vsce login sealant-sh`.
3. **Open VSX account.** Register an Eclipse account at <https://accounts.eclipse.org/user/register>
   with the **GitHub Username** field set to the GitHub account you will use. Sign in at
   <https://open-vsx.org> with that GitHub account, open **Settings**, choose **Log in with
   Eclipse**, then **Show Publisher Agreement** and **Agree**.
4. **Open VSX token and namespace.** In **Settings → Access Tokens**, generate a token for CI and
   copy it. Then create the namespace:

   ```sh
   npx ovsx create-namespace sealant-sh -p <open-vsx-token>
   ```

   The namespace works unverified; Open VSX marks it so until ownership is claimed through its
   [namespace access](https://github.com/eclipse/openvsx/wiki/Namespace-Access) process.

5. **The environment and its secrets.** In the repository's **Settings → Environments**, create
   `vscode-marketplace`: add yourself as a **required reviewer**, and under **Deployment branches
   and tags** allow the branch `main` and tags matching `vscode-v*`. Add the two tokens as
   environment secrets there, `VSCE_PAT` and `OVSX_PAT`, so only the approved publish job can read
   them:

   ```sh
   gh api -X PUT repos/sealant-sh/Mend/environments/vscode-marketplace
   gh secret set VSCE_PAT --repo sealant-sh/Mend --env vscode-marketplace
   gh secret set OVSX_PAT --repo sealant-sh/Mend --env vscode-marketplace
   ```

   Add the reviewer and the deployment rules in the web UI. The workflow refuses to publish while
   the environment has no required reviewer, since GitHub would otherwise create it unprotected.

## Publish a version

After Mend's own release of the same minor (the extension needs that server):

```sh
git tag vscode-v0.36.0 <merged commit on main> && git push origin vscode-v0.36.0
```

or dispatch from main, which tags the commit it published:

```sh
gh workflow run publish-vscode.yml --repo sealant-sh/Mend --ref main
```

Approve the `vscode-marketplace` deployment when the run asks. A re-run, or a dispatch from the
existing `vscode-vX.Y.Z` tag, skips what a registry already has and adds a missing release asset; it
never replaces a published version. A version is published from one commit: a tag that already names
another commit is refused, so a change needs a version bump.

Check the result:

```sh
npx @vscode/vsce show sealant-sh.mend
curl -s https://open-vsx.org/api/sealant-sh/mend | jq -r .version
```

The Marketplace can take a few minutes to show a new version after `vsce publish` returns.

## Before 2026-12-01: replace VSCE_PAT

Azure DevOps retires global personal access tokens, the **All accessible organizations** kind the
Marketplace needs, on 2026-12-01; `VSCE_PAT` stops working that day
([Microsoft's announcement](https://devblogs.microsoft.com/devops/retirement-of-global-personal-access-tokens-in-azure-devops)).
The replacement is Microsoft Entra ID: a user-assigned managed identity with a federated credential
for this repository's `vscode-marketplace` environment, added to the `sealant-sh` publisher as a
Contributor, and `azure/login` followed by `vsce publish --azure-credential` in the publish job
([VS Code's publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)).
It needs an Azure subscription. Open VSX is unaffected; `ovsx` also supports trusted publishing
(OIDC) if `OVSX_PAT` should go too.
