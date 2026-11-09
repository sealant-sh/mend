{
  lib,
  fetchurl,
  nodejs-slim_26,
  pnpm_10,
}:
let
  packageManager = (lib.importJSON ../package.json).packageManager;
  version = lib.removePrefix "pnpm@" packageManager;
  hashes = {
    "10.32.1" = "sha256-m5Q7lLyPVe+5k6rY5EtTjmsJHmCp5KlE3N6GmFXyM+M=";
  };
in
(pnpm_10.override { nodejs-slim = nodejs-slim_26; }).overrideAttrs (_: {
  inherit version;
  src = fetchurl {
    url = "https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz";
    hash =
      hashes.${version} or (throw ''
        package.json asks for ${packageManager}, and nix/pnpm.nix has no hash for it.
        Add "${version}" to `hashes` there: run `nix store prefetch-file https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz`.
      '');
  };
})
