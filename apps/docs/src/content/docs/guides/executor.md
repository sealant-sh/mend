---
title: Services through Executor
description: Add services, connect your accounts, and approve agent calls in Mend.
---

[Executor](https://executor.sh) gives agents tools for services such as Linear or Figma. An
organization uses one Executor. Its service logins stay in Executor; agents call through Mend
without receiving those credentials. Mend adds no services until someone chooses to add one.

## Choose the organization's Executor

An owner opens **Settings → Organization → Executor** and chooses either:

- **Mend runs Executor for this organization.** Sealant starts a private Executor with a 1.5 GiB
  memory limit and retained storage. Mend shows the runtime and observed state before starting.
  Docker is supported; Mend refuses this choice where Sealant cannot run it, including Kubernetes
  until its runtime has been verified. People use Mend's address throughout setup and linking.
- **Use an Executor this organization already has.** Enter its address and link Mend's member.
  People add services and connect accounts in that Executor. Mend lists the tools each link can use
  and provides a link to the organization's Executor.

Mend's member supplies calls for people without a personal Executor link. It can use only services
and accounts shared with everyone. Owners manage it from the organization's Executor settings.

For a Mend-run Executor, **Stop** keeps its service logins and storage. **Upgrade** stops it, saves
a backup of its volume, and starts the image pinned by the Mend release. **Remove** explicitly
deletes the organization's service logins, retained volume, backups and Mend's stored grants. The
confirmation describes that deletion. A later start creates a new Executor.

## Link your account

Open **Settings → You → Workspace** and choose **Link** under Executor. For a Mend-run Executor this
is one click. Mend signs you in privately and obtains the grants needed to call tools and manage
your service accounts. No Executor sign-in page reaches your browser. With the organization's own
Executor, complete its consent page and return to Mend.

Your sessions use your linked account. Without a link, they use Mend's member. Unlinking removes
Mend's consent to call as you; disconnect individual service accounts separately when you want to
delete those logins from Executor.

## Add a service

With a Mend-run Executor, owners add a name and **MCP address** under **Shared services** in the
organization's Executor settings. **Add service for everyone** imports the service as Mend's member
and shares it with everyone. If import succeeds but sharing does not, reload and choose **Share with
everyone** on that service.

To add a service only you can see, use the service form under your own Executor link in Workspace
settings. The service stays private to your link.

An MCP address must allow anonymous discovery or advertise OAuth sign-in. It cannot contain a login,
query parameters or fragment. An API-key service needs a service definition already in Executor; its
account can then be connected in Mend.

## Connect and disconnect accounts

Choose a service's sign-in method. For OAuth, Mend opens the service's own sign-in page. After you
consent, the service returns to Mend's configured `APP_URL`, and Mend completes the connection with
Executor. The browser never opens the Mend-run Executor. If sign-in expires or cannot finish, start
connecting again.

For an API-key method, enter the requested fields in Mend. Secret fields are masked. Mend sends the
values to Executor without storing them in its connection rows. Forms with unsupported field types
say so instead of guessing the required values.

Personal accounts belong to your link. Owners can connect shared accounts under **Shared services**;
those belong to Mend's member and are shared with everyone. **Use account** selects an account
Executor made available for that service. **Disconnect** deletes a login you manage from Executor
and removes its service links, after confirmation. Other services using that login lose it too.

Listings say **Executor answered · observed** with the time Mend read them. That describes the last
answer, not whether the next service call will succeed.

## Agent calls and approvals

Agents use the `mend` tools in a session to discover and call available service tools. Mend records
the service, tool, whose link supplied the call and what Executor returned. When Executor holds a
call, the person whose link it uses approves or denies it in Mend. The agent cannot approve it.
