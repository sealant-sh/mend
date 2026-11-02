import type { SettingsSection } from "./index";

/** Where an old Configuration anchor lives now: a project tab, or a Settings tab. */
export type AnchorTarget =
  | { readonly tab: "skills" | "resources" }
  | { readonly section: SettingsSection };

/**
 * Every section id the old Configuration page carried (`509837c0c2`), by where it moved. An
 * anchor the page never had, or none, opens General.
 */
const TARGETS: Readonly<Record<string, AnchorTarget>> = {
  visibility: { section: "general" },
  links: { section: "general" },
  references: { section: "general" },
  remove: { section: "general" },
  environment: { section: "workspace" },
  dotfiles: { section: "workspace" },
  "hot-sessions": { section: "workspace" },
  "install-command": { section: "workspace" },
  services: { section: "services" },
  variables: { section: "secrets" },
  secrets: { section: "secrets" },
  "cluster-bindings": { section: "secrets" },
  git: { section: "git" },
  "git-access": { section: "git" },
  sessions: { section: "landing" },
  landing: { section: "landing" },
  review: { section: "review" },
  folders: { section: "folders" },
  mounts: { section: "folders" },
  skills: { tab: "skills" },
  resources: { tab: "resources" },
};

export const anchorTarget = (hash: string): AnchorTarget =>
  TARGETS[hash.replace(/^#/, "")] ?? { section: "general" };
