{
  lib,
  stdenv,
  callPackage,
  fetchPnpmDeps,
  pnpmConfigHook,
  nodejs-slim_26,
  makeWrapper,
  installShellFiles,
}:
let
  root = ../.;
  pnpm = callPackage ./pnpm.nix { };
  nodejs = nodejs-slim_26;
  cliName = "@sealant/mend";

  packageDirsIn =
    group:
    let
      dir = root + "/${group}";
      isPackage = name: type: type == "directory" && builtins.pathExists (dir + "/${name}/package.json");
    in
    map (name: dir + "/${name}") (lib.attrNames (lib.filterAttrs isPackage (builtins.readDir dir)));
  workspaceDirs = lib.concatMap packageDirsIn [
    "apps"
    "packages"
    "tooling"
  ];
  manifestOf = dir: lib.importJSON (dir + "/package.json");
  dirByName = lib.listToAttrs (map (dir: lib.nameValuePair (manifestOf dir).name dir) workspaceDirs);
  workspaceDependencies =
    name:
    let
      manifest = manifestOf dirByName.${name};
      ranges =
        manifest.dependencies or { }
        // manifest.devDependencies or { }
        // manifest.optionalDependencies or { }
        // manifest.peerDependencies or { };
    in
    lib.attrNames (lib.filterAttrs (_: range: lib.hasPrefix "workspace:" range) ranges);
  cliWorkspace = map (item: dirByName.${item.key}) (
    builtins.genericClosure {
      startSet = [ { key = cliName; } ];
      operator = item: map (key: { inherit key; }) (workspaceDependencies item.key);
    }
  );

  src = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.difference (lib.fileset.unions (
      [
        ../package.json
        ../pnpm-lock.yaml
        ../pnpm-workspace.yaml
        ../patches
      ]
      ++ cliWorkspace
    )) (lib.fileset.fileFilter (file: lib.hasInfix ".test." file.name) root);
  };

  version = (manifestOf dirByName.${cliName}).version;

  pinned = lib.importJSON ./pnpm-deps.json;
  lockfileHash = builtins.hashFile "sha256" ../pnpm-lock.yaml;
in
assert
  lockfileHash == pinned.lockfile
  || throw ''
    nix/pnpm-deps.json was computed for a different pnpm-lock.yaml, so its dependency hash is stale.
    Run nix/update-pnpm-deps.sh and commit nix/pnpm-deps.json.
  '';
stdenv.mkDerivation (finalAttrs: {
  pname = "mend";
  inherit version src;

  pnpmWorkspaces = [ "${cliName}..." ];
  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs)
      pname
      version
      src
      pnpmWorkspaces
      ;
    inherit pnpm;
    fetcherVersion = 4;
    hash = pinned.hash;
  };

  nativeBuildInputs = [
    nodejs
    pnpm
    pnpmConfigHook
    makeWrapper
    installShellFiles
  ];

  buildPhase = ''
    runHook preBuild
    pnpm --filter=${cliName} run build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    pnpm --filter=${cliName} deploy --prod --offline --ignore-scripts \
      --config.inject-workspace-packages=true $out/lib/mend
    rm $out/lib/mend/pnpm-lock.yaml
    # bun-ffi-structs declares a typescript peer it never loads, and pnpm installs the peer:
    # TypeScript's native compiler, nearly 30 MiB.
    rm -r $out/lib/mend/node_modules/.pnpm/{typescript,@typescript+typescript-*}@*
    find $out/lib/mend/node_modules -path '*/.bin/tsc*' -delete
    find $out/lib/mend/node_modules -xtype l -delete

    makeWrapper ${lib.getExe nodejs} $out/bin/mend --add-flags $out/lib/mend/dist/main.js
    installManPage $out/lib/mend/man/*.1
    rm -r $out/lib/mend/man
  ''
  + lib.optionalString (stdenv.buildPlatform.canExecute stdenv.hostPlatform) ''
    installShellCompletion --cmd mend \
      --bash <($out/bin/mend completions bash) \
      --zsh <($out/bin/mend completions zsh)
  ''
  + ''
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    $out/bin/mend --version | grep -F ${version}
    (cd $out/lib/mend && ${lib.getExe nodejs} --experimental-ffi --disable-warning=ExperimentalWarning \
      --input-type=module -e 'const { resolveRenderLib } = await import("@opentui/core"); resolveRenderLib();')
    runHook postInstallCheck
  '';

  meta = {
    description = "Run your coding agent in a recorded git worktree and review its change with Mend";
    homepage = "https://github.com/sealant-sh/Mend";
    license = lib.licenses.asl20;
    mainProgram = "mend";
    platforms = [
      "aarch64-darwin"
      "aarch64-linux"
      "x86_64-linux"
    ];
  };
})
