import type { Configuration } from "electron-builder";

/**
 * Packages the built app (`out/`, from electron-vite) for Linux and macOS.
 * `pnpm -F @mend/desktop package` builds, then packages for the host platform;
 * append `--linux` or `--mac` to pick one. Artifacts land in release/
 * (gitignored).
 *
 * electron-vite bundles every import into out/: main and preload need only
 * electron and node builtins, and the renderer is one Vite build that already
 * holds the vendored ghostty wasm and the fonts under out/renderer/assets. So
 * the package ships no node_modules. package.json lists nothing under
 * `dependencies`, and `beforeBuild` answers false: without it electron-builder
 * finds no dependencies here, falls back to the workspace root and packs the
 * root's (effect and its tree, msgpackr's native addon).
 */
const config: Configuration = {
  appId: "run.mend.desktop",
  productName: "Mend",
  copyright: "Copyright © Sealant",
  directories: { output: "release", buildResources: "resources" },
  files: ["out/**/*", "package.json"],
  asar: true,
  // No native modules, so nothing to install or rebuild against Electron's
  // ABI. False here also stops the node_modules search (see above); setting
  // `npmRebuild: false` instead would return before this hook runs.
  beforeBuild: async () => false,
  artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
  // Electron takes the Wayland app_id / X11 WM_CLASS from desktopName; with
  // syncDesktopName the AppImage's .desktop entry carries the same name, so the
  // desktop links the running window to it.
  extraMetadata: { desktopName: "mend-desktop.desktop" },
  linux: {
    target: ["AppImage", "tar.gz"],
    executableName: "mend-desktop",
    icon: "resources/icon.png",
    category: "Development",
    synopsis: "Mend desktop",
    syncDesktopName: true,
  },
  // Unsigned and not notarized. Gatekeeper refuses the first open; right-click
  // › Open, or `xattr -dr com.apple.quarantine /Applications/Mend.app`.
  // On a Linux host the .app and the zip build, and the dmg stops at `sips`
  // (a macOS tool), so the dmg needs a macOS machine or runner.
  mac: {
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ],
    icon: "resources/icon.png",
    category: "public.app-category.developer-tools",
    identity: null,
    notarize: false,
    hardenedRuntime: false,
  },
};

export default config;
