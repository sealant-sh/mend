---
title: Install Mend with Nix
description:
  Add the mend CLI to a NixOS or home-manager configuration, and run the Mend server with
  services.mend.
sidebar:
  order: 3
---

Mend's repository is a Nix flake. It gives you the `mend` CLI as a package and the Mend server as a
NixOS module, `services.mend`. The module runs the same container images and the same Compose files
as the [Docker installation](/getting-started/install/).

The flake builds the CLI from source, against the repository's `pnpm-lock.yaml`, on Node.js 26. The
package runs on `aarch64-darwin`, `aarch64-linux` and `x86_64-linux`. Nixpkgs 26.11 dropped
`x86_64-darwin`, so on an Intel Mac install the CLI with `npm install --global @sealant/mend`
instead.

## Run the CLI without installing it

```sh
nix run github:sealant-sh/mend -- login --url https://mend.example.com
```

Replace `https://mend.example.com` with your Mend server's URL. `mend login` writes the URL and the
sign-in to `~/.config/mend/cli.json`, the same file an npm install uses.

## Add the CLI to your configuration

Add the flake as an input:

```nix
{
	inputs.mend.url = "github:sealant-sh/mend";
}
```

Do not make the input follow your own `nixpkgs`. The build needs the `fetchPnpmDeps` and Node.js 26
of the nixpkgs revision the flake pins, which a stable NixOS release does not have.

On NixOS, add the package to the system:

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

## Follow releases instead of main

`github:sealant-sh/mend` follows the default branch. To stay on a release, pin the input to its tag,
replacing `vX.Y.Z` with a tag from the [releases page](https://github.com/sealant-sh/Mend/releases):

```nix
{
	inputs.mend.url = "github:sealant-sh/mend/vX.Y.Z";
}
```

To update, change the tag and rebuild. For an input without a tag, run `nix flake update mend`, then
rebuild.

## Run the server on NixOS

Import the module and give the server its URL:

```nix
{ inputs, ... }:
{
	imports = [ inputs.mend.nixosModules.mend ];

	services.mend = {
		enable = true;
		url = "http://localhost:3105";
	};
}
```

After a switch, `mend.service` starts the containers that `deploy/docker/compose.v2.yaml` defines:
Mend, Postgres and Garage, with the npm and Docker mirrors beside them. The first start pulls about
660 MB of images. The module also turns on Docker and allows the unprivileged user namespaces that
each workspace's rootless Docker needs. On Ubuntu, `mend server setup` asks before it changes that
setting.

The server version is the version of the CLI in the same flake, so the image is
`ghcr.io/sealant-sh/mend:<version>`. To upgrade the server, update the flake input and switch.
Unlike `mend server upgrade`, a switch does not save a database backup first. Before you update,
back up the Docker volume `mend_mend-postgres`.

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
unless `url` is that origin. With the configuration above, sign the CLI in from your laptop with
`mend login --url http://localhost:3105` while the tunnel is open.

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
[Exposure and the public gate](/operate/exposure/) first.

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

### Keep the identity in your secret manager

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

### What stays manual

- Creating the first account, as above.
- Backups. Mend's data lives in Docker volumes (`mend-store`, `mend-control`, `mend-garage` and
  `mend_mend-postgres`, among others), under Docker's data root. To move it, set
  `virtualisation.docker.daemon.settings.data-root`.
- Lifecycle. `mend server status`, `mend server upgrade` and `mend uninstall --server` manage an
  install that `mend server setup` made, not this one. Use `systemctl` and `journalctl` for the
  unit, and `docker compose --project-name mend` for its containers.
- Settings the module has no option for, such as a Docker Hub login for the mirror, the t3code
  gateway and previews. Set Mend's environment with `services.mend.environment`, or add a Compose
  file with `services.mend.extraComposeFiles`. [Server environment](/reference/server-environment/)
  lists every variable.
