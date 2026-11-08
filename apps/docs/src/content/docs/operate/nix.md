---
title: Install Mend with Nix
description: Add the mend CLI to a NixOS or home-manager configuration from Mend's flake.
sidebar:
  order: 3
---

Mend's repository is a Nix flake. It builds the `mend` CLI from source, against the repository's
`pnpm-lock.yaml`, on Node.js 26. The package runs on `aarch64-darwin`, `aarch64-linux` and
`x86_64-linux`. Nixpkgs 26.11 dropped `x86_64-darwin`, so on an Intel Mac install the CLI with
`npm install --global @sealant/mend` instead.

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
