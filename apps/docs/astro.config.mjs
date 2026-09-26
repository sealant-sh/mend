import starlight from "@astrojs/starlight";
import mermaid from "astro-mermaid";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://docs.mend.run",
  integrations: [
    mermaid({ autoTheme: true, enableLog: false }),
    starlight({
      title: "Mend",
      description: "Documentation for the local-first agent workbench.",
      logo: {
        light: "./src/assets/mend-mark-light.svg",
        dark: "./src/assets/mend-mark-dark.svg",
        replacesTitle: false,
      },
      social: [
        {
          icon: "github",
          label: "Mend on GitHub",
          href: "https://github.com/sealant-sh/mend",
        },
      ],
      customCss: ["./src/styles/custom.css"],
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Introduction", slug: "index" },
            { label: "How Mend works", slug: "concepts/how-mend-works" },
            { label: "Install Mend", slug: "getting-started/install" },
            { label: "Connect provider accounts", slug: "guides/provider-accounts" },
            { label: "Adopt a project", slug: "getting-started/adopt-project" },
            { label: "Start a session", slug: "getting-started/first-session" },
          ],
        },
        {
          label: "Work with changes",
          items: [
            { label: "Review a change", slug: "guides/review-a-change" },
            { label: "Land a change", slug: "guides/land-a-change" },
          ],
        },
        {
          label: "Clients",
          items: [
            { label: "Work from another device", slug: "guides/remote-access" },
            { label: "Terminal dashboard", slug: "clients/terminal" },
            { label: "Desktop app", slug: "clients/desktop" },
            { label: "VS Code extension", slug: "clients/vscode" },
          ],
        },
        {
          label: "Project setup",
          items: [
            { label: "Session environments", slug: "guides/project-environment" },
            { label: "Workspace images", slug: "guides/workspace-images" },
            { label: "Variables and secrets", slug: "guides/environment-variables" },
            { label: "Dotfiles", slug: "guides/dotfiles" },
            { label: "Git access", slug: "guides/git-access" },
            { label: "Development services", slug: "guides/services" },
            { label: "Skills", slug: "guides/skills" },
          ],
        },
        {
          label: "Organizations",
          items: [
            { label: "Organizations and members", slug: "organizations/overview" },
            { label: "Folders", slug: "organizations/folders" },
          ],
        },
        {
          label: "Integrations",
          items: [{ label: "Slack", slug: "integrations/slack" }],
        },
        {
          label: "Operate",
          items: [
            { label: "Deploy on a VPS", slug: "operate/deploy-vps" },
            { label: "Deploy on Kubernetes", slug: "operate/deploy-kubernetes" },
            { label: "Exposure and the public gate", slug: "operate/exposure" },
            { label: "Troubleshooting", slug: "operate/troubleshooting" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { label: "Product model", slug: "concepts/product-model" },
            { label: "Context", slug: "concepts/context" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Feature status", slug: "reference/feature-status" },
            { label: "CLI", slug: "reference/cli" },
            { label: "Server environment", slug: "reference/server-environment" },
            { label: "Product language", slug: "reference/product-language" },
          ],
        },
      ],
    }),
  ],
});
