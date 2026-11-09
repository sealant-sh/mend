{
  description = "Mend: the mend CLI and the development shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/6b5e5b7a6631f065bf6908986990b37d845f847f";

  outputs =
    { self, nixpkgs, ... }:
    let
      # x86_64-darwin is gone: nixpkgs 26.11 refuses to evaluate it.
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      # The flake's own build, not final.callPackage: the build needs fetchPnpmDeps fetcherVersion 4
      # and nodejs-slim_26, which a stable NixOS's nixpkgs may not have.
      overlays.default = final: prev: {
        mend = self.packages.${final.stdenv.hostPlatform.system}.mend;
      };

      packages = forAllSystems (pkgs: rec {
        mend = pkgs.callPackage ./nix/package.nix { };
        default = mend;
      });

      apps = forAllSystems (
        pkgs:
        let
          mend = {
            type = "app";
            program = nixpkgs.lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.mend;
            meta.description = "The mend CLI";
          };
        in
        {
          inherit mend;
          default = mend;
        }
      );

      checks = forAllSystems (pkgs: {
        inherit (self.packages.${pkgs.stdenv.hostPlatform.system}) mend;
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_26
            (pkgs.callPackage ./nix/pnpm.nix { })
          ];
        };
      });
    };
}
