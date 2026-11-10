---
title: Install Mend with Nix
description:
  Run the Mend server on NixOS with services.mend, and add the mend CLI to a NixOS or home-manager
  configuration.
sidebar:
  order: 3
---

Mend's repository is a Nix flake. It gives you the Mend server as a NixOS module, `services.mend`,
and the `mend` CLI as a package. The module runs the same container images and the same Compose
files as the [Docker installation](/getting-started/install/), through Docker Compose. Every
question `mend server setup` asks is a module option, so you never run setup on NixOS.

The flake first ships in Mend 0.37.0. Earlier release tags have no `nixosModules`.

## Quick start

This installs Mend on a NixOS server at `https://mend.example.com`, with its own TLS certificate,
and connects T3 Code to it at `https://t3.mend.example.com`. Before you start, point both DNS names
at the server, and make sure ports 80 and 443 reach it from the internet. Replace the names, the
host name `my-server` and the release `vX.Y.Z` with your own throughout.

1. Add the Mend flake as an input, pinned to a release tag from the
   [releases page](https://github.com/sealant-sh/Mend/releases), and pass the inputs to your
   configuration with `specialArgs`. A complete `flake.nix`:

   ```nix
   {
   	inputs = {
   		nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
   		mend.url = "github:sealant-sh/mend/vX.Y.Z";
   	};

   	outputs =
   		{ nixpkgs, ... }@inputs:
   		{
   			nixosConfigurations.my-server = nixpkgs.lib.nixosSystem {
   				system = "x86_64-linux";
   				specialArgs = { inherit inputs; };
   				modules = [ ./configuration.nix ];
   			};
   		};
   }
   ```

   Do not add `inputs.mend.inputs.nixpkgs.follows = "nixpkgs"`. The flake builds the `mend` CLI with
   the `fetchPnpmDeps` and Node.js 26 of the nixpkgs revision it pins. A stable NixOS release does
   not have them, so the build fails against your own nixpkgs. The module itself uses your system's
   nixpkgs either way.

2. Import the module in `configuration.nix`, and add the CLI to the system:

   ```nix
   { inputs, pkgs, ... }:
   {
   	imports = [ inputs.mend.nixosModules.mend ];

   	environment.systemPackages = [ inputs.mend.packages.${pkgs.stdenv.hostPlatform.system}.mend ];

   	services.mend = {
   		enable = true;
   		url = "https://mend.example.com";
   		edge.enable = true;
   		openFirewall = true;
   		t3Gateway = {
   			enable = true;
   			host = "t3.mend.example.com";
   		};
   	};
   }
   ```

3. Set `url` to the origin people open Mend at, with no path. With the edge on, it must be
   `https://` followed by the DNS name of step 1.

4. Build and switch to the configuration:

   ```sh
   sudo nixos-rebuild switch --flake .#my-server
   ```

   `mend.service` pulls about 660 MB of images and starts Mend, Postgres, Garage and the two
   mirrors. Follow the start with `journalctl -u mend.service -f`. It ends with
   `mend: no account exists yet`. The edge stays down until the first account exists.

5. Create the first account. On your laptop, open a tunnel to the server:

   ```sh
   ssh -L 3105:127.0.0.1:3105 my-server
   ```

   Open `http://localhost:3105` and create the account. It becomes the owner of the instance's
   organization and its operator. Then, on the server, run `sudo systemctl restart mend`. The log
   says `the edge serves https://mend.example.com`.

6. Sign the CLI in, and connect T3 Code:

   ```sh
   mend login --url https://mend.example.com
   mend pair
   ```

   `mend pair` prints a pairing code and the gateway's address, `https://t3.mend.example.com`. In T3
   Code, add an environment with **Remote link**, and enter that address and the code.

The sections below explain each step and the options around it.

### Without flakes

`builtins.getFlake` loads the module into a configuration that is not a flake:

```nix
{
	imports = [ (builtins.getFlake "github:sealant-sh/mend/vX.Y.Z").nixosModules.mend ];
}
```

It works only with flakes enabled in Nix
(`nix.settings.experimental-features = [ "nix-command" "flakes" ];`). Mend has no `default.nix` for
configurations without flakes.

## Run the server on NixOS

A switch writes a one-shot unit, `mend.service`, that runs `docker-compose up --no-build` with the
published images and the Compose files in `deploy/docker`. Systemd runs only Docker Compose, never
Mend itself. The module also turns on Docker and allows the unprivileged user namespaces that each
workspace's rootless Docker needs. On Ubuntu, `mend server setup` asks before it changes that
setting.

The server version is the version of the CLI in the same flake, so the image is
`ghcr.io/sealant-sh/mend:<version>`. To upgrade the server, change the input's tag and switch. For
an input with no tag, run `nix flake update mend`, then switch. Unlike `mend server upgrade`, a
switch does not save a database backup first. Before you update, back up the Docker volume
`mend_mend-postgres`.

To follow the start, read the unit's log:

```sh
journalctl -u mend.service -f
```

### Create the first account

Registration closes after the first account. That account becomes the owner of the instance's
organization and its operator. Until it exists, Mend also allows the origin `http://localhost:3105`,
whatever `url` says, so you can create the account over an SSH tunnel before anyone else reaches the
server. Open the tunnel from your laptop, then open `http://localhost:3105` and create the account:

```sh
ssh -L 3105:127.0.0.1:3105 your-server
```

Then run `sudo systemctl restart mend` on the server. Mend stops allowing `http://localhost:3105`
unless `url` is that origin.

To run Mend for this machine only, set `url = "http://localhost:3105";` and leave the edge off. Sign
the CLI in from your laptop with `mend login --url http://localhost:3105` while the tunnel is open.

### Serve Mend over HTTPS with the bundled edge

The bundled edge is the Caddy service from `deploy/docker/compose.edge.yaml`. It obtains a
certificate for the URL's hostname and keeps Mend's own port on loopback:

```nix
{
	services.mend = {
		enable = true;
		url = "https://mend.example.com";
		edge.enable = true;
		openFirewall = true;
	};
}
```

The edge starts only after the first account exists, because until then registration is open to
whoever reaches the URL first. To bring the edge up:

1. Point the DNS name at the server, and switch to the configuration above.
2. On your laptop, run `ssh -L 3105:127.0.0.1:3105 your-server`.
3. Open `http://localhost:3105` and create the first account.
4. On the server, run `sudo systemctl restart mend`.

After the restart, Mend no longer allows `http://localhost:3105`, and the edge serves
`https://mend.example.com`. Sign the CLI in with `mend login --url https://mend.example.com`.

To declare the instance public, add `exposure = "public";` and switch. On a fresh install the server
refuses to start as public, and `journalctl -u mend.service` shows why. Read
[Exposure and the public gate](/operate/exposure/) first. Each item of the gate you verified from
outside goes in `declared`, such as `declared = [ "edge-tls" ];`.

`openFirewall` opens 80/tcp, 443/tcp and 443/udp, the port Mend uses for screen video. Docker
publishes ports with firewall rules of its own, so `edge.bindHost` and `bind.host` decide which
networks reach a port, not the NixOS firewall.

### Use your own reverse proxy

To put NixOS's own `services.caddy`, or another proxy, in front of Mend, leave the edge off and
proxy to Mend's loopback port:

```nix
{
	services.mend = {
		enable = true;
		url = "https://mend.example.com";
	};

	services.caddy = {
		enable = true;
		virtualHosts."mend.example.com".extraConfig = ''
			reverse_proxy 127.0.0.1:3105 {
				flush_interval -1
			}
		'';
	};
}
```

Create the first account over the SSH tunnel, as in
[Create the first account](#create-the-first-account), before you start the proxy. Until then,
registration is open to whoever reaches the URL first. `flush_interval -1` keeps terminals and the
event stream unbuffered. Your proxy's access log records each request's full URL. The bundled edge's
`Caddyfile` removes the single-use tickets and invitation paths those URLs can carry, and a proxy of
your own does not. The module accepts `exposure = "public"` only with the bundled edge.

## Connect T3 Code

The [t3code gateway](/integrations/t3code/) lets T3 Code's desktop, mobile and web clients add Mend
as a remote environment. It runs in the Mend container on a port of its own, `3120`, the same way
`mend server setup --t3-gateway` turns it on. Where T3 Code reaches it depends on how people reach
Mend.

With the bundled edge, serve the gateway on a DNS name of its own. T3 Code always uses a server's
root path, so the gateway cannot share Mend's origin:

```nix
{
	services.mend.t3Gateway = {
		enable = true;
		host = "t3.mend.example.com";
	};
}
```

Point that name where `edge.host` points. The edge gets its certificate and serves it once the first
account exists, and T3 Code's Remote link takes `https://t3.mend.example.com`. The gateway's own
port stays on `127.0.0.1:3120`.

Without the edge, the gateway's port is published where Mend's web port is, on `bind.host`, and T3
Code's Remote link takes `http://<the hostname of url>:3120`. On a private network or a tailnet:

```nix
{
	services.mend = {
		enable = true;
		url = "http://mend-box.tail1234.ts.net:3105";
		bind.host = "100.70.80.90";
		openFirewall = true;
		t3Gateway.enable = true;
	};
}
```

`t3Gateway.port` picks another host port, and `t3Gateway.bindHost` another address. `openFirewall`
opens the gateway's port when its address is not loopback. With the edge, the gateway's address
stays on loopback, and the module refuses any other.

To pair a client, sign the CLI in and run `mend pair`. It prints a code, good for one device for ten
minutes, and the gateway's address. In T3 Code, add an environment with **Remote link**, and enter
that address, with its `http://` or `https://`, and the code. `mend doctor` shows the same address
on its `t3code gateway` line.

While the gateway is on, the exposure gate lists `t3code-gateway`. Behind the edge it stays open
until you verify `https://t3.mend.example.com/.well-known/t3/environment` from another network and
add `"t3code-gateway"` to `declared`. On a private network its port is open until you check who
reaches it and declare it the same way. Turning the gateway off keeps its pairings in the Docker
volume `mend_mend-t3-gateway`.

## Choose where new sessions run

New sessions run in Docker on this server by default. To run them on Boat instead, set:

```nix
{
	services.mend.sessions.runtime = "boat";
}
```

The option sets `MEND_SESSION_RUNTIME`, which picks only where new sessions run. Existing worktrees
keep the runtime they started with. Boat's key and deployment settings, its optional resource
gateway and the public session and capture endpoints are configured apart from this option, and
until the key and settings are, a Boat session reports a refusal. It never starts on Docker instead.
Read [Where sessions run](/reference/server-environment/#where-sessions-run) and
[Remote workspace endpoints](/reference/server-environment/#remote-workspace-endpoints) before you
switch. Null, the default, keeps the server's default, `docker`.

## Keep the identity in your secret manager

On its first start, the module writes the install's secrets to `/var/lib/mend/identity.env`. The
SHA-256 of that file's exact bytes marks the Docker volumes as this install's, so back the file up
and never change it.

To keep it in sops-nix or agenix instead, store the file's contents as a secret and point
`secretsFile` at the decrypted path. With sops-nix:

```nix
{ config, ... }:
{
	sops.secrets.mend-identity = { };
	services.mend.secretsFile = config.sops.secrets.mend-identity.path;
}
```

With agenix, use `config.age.secrets.mend-identity.path`. The file has seven `KEY=value` lines, in
the format `mend server setup` writes: `MEND_POSTGRES_ADMIN_PASSWORD`, `MEND_DB_PASSWORD`,
`SEALANT_DB_PASSWORD`, `BETTER_AUTH_SECRET`, `SEALANT_CREDENTIALS_KEY`, `SEALANT_SERVICE_KEY` and
`WORKSPACE_SSH_GATEWAY_TOKEN`. The module checks each value's format when the unit starts.

## Setup's questions and their options

Each question `mend server setup` asks is an option here, a step the module takes by itself, or a
setting that stays manual. To change an answer, change the option and switch.

| `mend server setup` asks                                                          | On NixOS                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which Docker should Mend run in?                                                  | Automatic. The module turns on `virtualisation.docker` and uses its socket, `/run/docker.sock`.                                                                                                                   |
| Remove them now? (what an earlier install left)                                   | Automatic. The unit removes the edge and mirror containers its own configuration no longer runs. It never removes another install's volumes. If one holds a volume, the unit stops, and its log names the volume. |
| How will people reach this Mend?                                                  | `bind.host`, `edge.enable` and `exposure`.                                                                                                                                                                        |
| Which network do people reach it on?                                              | `bind.host`, and `bind.port` for the port.                                                                                                                                                                        |
| Your domain for Mend                                                              | `url`, and `edge.host`, which defaults to the hostname of `url`.                                                                                                                                                  |
| Should VS Code Remote-SSH and mend ssh reach sessions from other machines?        | `ssh.bindHost` and `ssh.port`. `sshHost` sets the name workspaces are reached at.                                                                                                                                 |
| Allow `<origin>` as a browser origin too? Allow another origin, or take one away? | `allowedOrigins`.                                                                                                                                                                                                 |
| Turn on the T3 Code gateway?                                                      | `t3Gateway.enable`, `t3Gateway.port` and `t3Gateway.bindHost`.                                                                                                                                                    |
| Serve it on a host of its own? The gateway's host                                 | `t3Gateway.host`.                                                                                                                                                                                                 |
| Keep live previews at `<address>`?                                                | Manual. The module has no option for previews.                                                                                                                                                                    |
| State what you have checked from outside the network now?                         | `declared`.                                                                                                                                                                                                       |
| Keep the mirrors as they are? Run the npm mirror? Run the Docker Hub mirror?      | `mirrors.npm.enable` and `mirrors.docker.enable`.                                                                                                                                                                 |
| its disk cap                                                                      | `mirrors.npm.maxSize` and `mirrors.docker.maxSize`.                                                                                                                                                               |
| One organization on this server, or several?                                      | `tenancy`.                                                                                                                                                                                                        |
| Where should new sessions run?                                                    | `sessions.runtime`.                                                                                                                                                                                               |
| Apply?                                                                            | Automatic. `sudo nixos-rebuild switch` applies the configuration.                                                                                                                                                 |
| (flags only) `--docker-hub-username`, `--docker-hub-token-stdin`                  | Manual. See [What stays manual](#what-stays-manual).                                                                                                                                                              |

## What stays manual

- Creating the first account, as in [Create the first account](#create-the-first-account).
- Backups. Mend's data lives in Docker volumes (`mend-store`, `mend-control`, `mend-garage` and
  `mend_mend-postgres`, among others), under Docker's data root. To move it, set
  `virtualisation.docker.daemon.settings.data-root`.
- Lifecycle. `mend server status`, `mend server upgrade` and `mend uninstall --server` manage an
  install that `mend server setup` made, not this one. Use `systemctl` and `journalctl` for the
  unit, `docker compose --project-name mend` for its containers, and `mend doctor` from a signed-in
  CLI for what the server reports.
- A Docker Hub login for the mirror. The token is a secret, so it cannot go in
  `services.mend.environment`, which lands in the Nix store. Read
  [A Docker Hub login](/operate/docker-mirror/#a-docker-hub-login) for the scope the token needs.
  Then keep a file outside the store, such as a sops-nix secret, with the lines
  `REGISTRY_PROXY_USERNAME=<user>` and `REGISTRY_PROXY_PASSWORD=<token>`. Give it to the mirror with
  a Compose file in `services.mend.extraComposeFiles` that sets `services.docker-mirror.env_file` to
  that path.
- Live previews. [Exposure and the public gate](/operate/exposure/#previews) describes what they
  need.
- Boat's own configuration, as in [Choose where new sessions run](#choose-where-new-sessions-run).
- Any other setting. Set Mend's environment with `services.mend.environment`, or add a Compose file
  with `services.mend.extraComposeFiles`. [Server environment](/reference/server-environment/) lists
  every variable.

## Add the CLI to your configuration

The flake builds the CLI from source, against the repository's `pnpm-lock.yaml`, on Node.js 26. The
package runs on `aarch64-darwin`, `aarch64-linux` and `x86_64-linux`. Nixpkgs 26.11 dropped
`x86_64-darwin`, so on an Intel Mac install the CLI with `npm install --global @sealant/mend`
instead.

To run it without installing it:

```sh
nix run github:sealant-sh/mend -- login --url https://mend.example.com
```

Replace `https://mend.example.com` with your Mend server's URL. `mend login` writes the URL and the
sign-in to `~/.config/mend/cli.json`, the same file an npm install uses.

On NixOS, add the package to the system, as in the [quick start](#quick-start):

```nix
{ inputs, pkgs, ... }:
{
	environment.systemPackages = [ inputs.mend.packages.${pkgs.stdenv.hostPlatform.system}.mend ];
}
```

With home-manager, add it to your user instead:

```nix
{ inputs, pkgs, ... }:
{
	home.packages = [ inputs.mend.packages.${pkgs.stdenv.hostPlatform.system}.mend ];
}
```

To refer to it as `pkgs.mend`, add the overlay. It gives the flake's own build, whatever nixpkgs
your configuration uses:

```nix
{ inputs, ... }:
{
	nixpkgs.overlays = [ inputs.mend.overlays.default ];
}
```

The package installs a man page for every command (`man mend-login`) and completions for bash and
zsh. Nix does not manage the CLI's configuration. The sign-in in `cli.json` is state that
`mend login` writes, and a `MEND_URL` set in your environment would override the URL it records.

`github:sealant-sh/mend` with no tag follows the default branch. Pin it to a release tag, as in the
quick start, to stay on a release.
