// The page's words: the claim, the capabilities, the integrations, the FAQ,
// and the install line. Layout lives in page.tsx; the words live here.

import {
  AppWindow,
  Boxes,
  FolderSync,
  Network,
  Pi,
  Smartphone,
  Terminal,
  Wand2,
} from "lucide-react";
import type { ReactNode } from "react";

import { BrandIcon } from "#/components/brand-icons";

export const REPO_URL = "https://github.com/sealant-sh/mend";
export const DISCORD_URL = "https://discord.gg/s88CtBSym";
export const DOCS_URL = "https://docs.mend.run";
export const DOCS_INSTALL_URL = `${DOCS_URL}/getting-started/install/`;
const DOCS_REMOTE_URL = `${DOCS_URL}/guides/remote-access/`;
const DOCS_KUBERNETES_URL = `${DOCS_URL}/operate/deploy-kubernetes/`;
export const INSTALL_COMMAND = "npm install --global @sealant/mend";

export const SUBLINE =
  "Your coding agents are scattered across laptops, terminals and worktrees. Mend runs them all on one server you own, each session in its own worktree and container. None of the usual remote pain. Your dev setup comes along, dev servers show up on localhost, and you can attach from anywhere.";
export const REQUIREMENTS_LINE = "Node 22+ · Docker · Linux or macOS";

/** The three commands from nothing to a running session. */
export const START_STEPS: ReadonlyArray<{ command: string; text: string }> = [
  {
    command: "npm install --global @sealant/mend",
    text: "Installs the CLI. Needs Node 22 or newer.",
  },
  {
    command: "mend server setup",
    text: "Starts the server on this machine, in Docker.",
  },
  {
    command: "mend claude",
    text: "Run it in any repository with a remote. Mend adopts the repository, checks out a worktree and starts the agent in it.",
  },
];

// ── capabilities ────────────────────────────────────────────────────────────

export interface Feature {
  readonly kicker: string;
  readonly title: string;
  readonly body: ReactNode;
}

export const FEATURES: ReadonlyArray<Feature> = [
  {
    kicker: "one machine · all your projects",
    title: "All your sessions and worktrees in one place",
    body: (
      <>
        <p>
          Agent sessions tend to spread out. Some run on the laptop, some on the desktop, a few in
          tmux panes, next to worktrees nobody remembers making. Mend keeps every project, worktree
          and session on one machine. Adopt a repository once and Mend clones it into its store.
          Every session checks out its worktree from there.
        </p>
        <p>
          Open the web app or run <Cmd>mend ui</Cmd> and it's all in one list. You can see every
          project and every session, which ones are running and which are waiting on you. It's the
          same list from your laptop, your phone or a terminal on another machine.
        </p>
      </>
    ),
  },
  {
    kicker: "cloud agents · your hardware",
    title: "Cloud agents on your own hardware",
    body: (
      <>
        <p>
          Your agents run on the Mend server. That can be a box under your desk, a VPS or a
          Kubernetes cluster. Close your laptop and they keep working. Attach again from a terminal,
          the browser or your phone and the live terminal is right where you left it. Want to poke
          around yourself? <Cmd>mend shell</Cmd> opens a terminal inside the session's workspace,
          right next to the agent.
        </p>
        <p>
          Remote agents usually lose everything that made your own machine useful. Mend keeps it.
          Sessions start with your dotfiles, your skills, the project's environment and secrets, and
          your git access. Dev servers run as Services, and Mend tunnels each one to the same port
          on the machine you're attached from. Open <Cmd>localhost:5173</Cmd> and you're looking at
          the agent's dev server.
        </p>
      </>
    ),
  },
  {
    kicker: "team · shared projects · shared control",
    title: "One server for your whole team",
    body: (
      <>
        <p>
          Put Mend on one server and invite the team with <Cmd>mend invite</Cmd>. Share a project
          with everyone or keep it to yourself. Everyone's sessions sit side by side, so you can
          open a teammate's session, see where it's at and read its change.
        </p>
        <p>
          Each person signs in with their own Claude, Codex and GitHub accounts and brings their own
          dotfiles and skills. Only a session's owner types into it, until they turn on shared
          control and a teammate can pick it up and keep going. In Slack, anyone on the team can ask{" "}
          <Cmd>@mend</Cmd> for work and follow up on it in the thread.
        </p>
      </>
    ),
  },
  {
    kicker: "preview · live link",
    title: "A live link to every change",
    body: (
      <>
        <p>
          When a session changes your app, Mend gives you a link to that change running live. You
          don't check out a branch or start anything yourself. Open the link and try it.
        </p>
        <p>
          The link shows up wherever Mend reports on the session: in the Slack thread, in the web
          app, on your phone. Most of the time you'll know whether the change works before you read
          a line of the diff.
        </p>
      </>
    ),
  },
  {
    kicker: "review · full record",
    title: "Code review that knows more than the diff",
    body: (
      <>
        <p>
          Mend gives you the kind of review you'd pay CodeRabbit for, running on your own hardware
          and your own Claude or Codex subscription. There's no per-seat review bill, and your code
          never goes to another review service.
        </p>
        <p>
          Sealant's runtime, sealantd, records every session as it runs: the prompts, the commands
          the agent ran, what they printed, and the order the files changed in. Mend reads the
          change against that complete record and gives you review comments with suggested fixes,
          plus a tour that walks you through the change in the order it was written.
        </p>
      </>
    ),
  },
  {
    kicker: "one session store · any harness",
    title: "Harness agnostic",
    body: (
      <>
        <p>
          Mend keeps every session in one store, whichever harness started it. The worktree, the
          record and the conversation belong to the session, and the harness is just what's running
          it right now.
        </p>
        <p>
          Any session can be resumed with any harness Mend supports. Start it in Codex and pick it
          up in Claude Code tomorrow.
        </p>
      </>
    ),
  },
  {
    kicker: "slack · github",
    title: "Ask in Slack, get a live preview and a pull request",
    body: (
      <p>
        Mention <Cmd>@mend</Cmd> in a thread and it starts a session for you, in the project it
        reads from the message, the thread or the channel default. When the work is done, Mend
        replies in the thread with a link to the change running live, so you can try it right from
        Slack. If the request asked for a change, Mend also pushes it to a branch and opens a pull
        request. It never merges and never force-pushes.
      </p>
    ),
  },
];

// ── integrations ────────────────────────────────────────────────────────────

export interface Integration {
  readonly name: string;
  readonly icon: ReactNode;
  readonly body: ReactNode;
  readonly fact: string;
}

export interface IntegrationGroup {
  readonly label: string;
  readonly note: string;
  readonly items: ReadonlyArray<Integration>;
}

const brand = (name: Parameters<typeof BrandIcon>[0]["name"]) => (
  <BrandIcon name={name} className="size-[18px]" />
);
const glyph = (Icon: typeof Terminal) => <Icon className="size-[18px]" aria-hidden="true" />;

export const INTEGRATION_GROUPS: ReadonlyArray<IntegrationGroup> = [
  {
    label: "Agents",
    note: "Each person signs in once with their own subscription.",
    items: [
      {
        name: "Claude Code",
        icon: brand("claude"),
        body: "Runs in its own terminal, unchanged, on your Claude login.",
        fact: "mend claude",
      },
      {
        name: "Codex",
        icon: brand("openai"),
        body: "The Codex CLI on your ChatGPT login. Resume across Codex and Claude Code.",
        fact: "mend codex",
      },
      {
        name: "OpenCode",
        icon: brand("opencode"),
        body: "Gets a worktree, a record and a review like the others.",
        fact: "mend opencode",
      },
      {
        name: "Pi",
        icon: glyph(Pi),
        body: "The Pi coding agent, with the same worktree, workspace and review as the rest.",
        fact: "mend pi",
      },
    ],
  },
  {
    label: "Where you work from",
    note: "Attach to the same session from several places at once.",
    items: [
      {
        name: "Terminal",
        icon: glyph(Terminal),
        body: "Attach to the agent, or open a shell in its workspace to run the tests yourself or look at a file. The dashboard keeps every project live.",
        fact: "mend attach · mend shell · mend ui",
      },
      {
        name: "VS Code",
        icon: brand("vscode"),
        body: "Our extension, published on the VS Code Marketplace. Open any session's workspace over Remote-SSH, and a claude or codex you start in its terminal is recorded.",
        fact: "VS Code Marketplace · Remote-SSH",
      },
      {
        name: "Browser",
        icon: glyph(AppWindow),
        body: "The live terminal, the project's sessions and the review, in the web app.",
        fact: "sessions · review · settings",
      },
      {
        name: "Phone",
        icon: glyph(Smartphone),
        body: "Apps for iOS and Android, in review on the App Store and Google Play.",
        fact: "iOS · Android · mend pair",
      },
    ],
  },
  {
    label: "Team and shipping",
    note: "Optional. Review works before anything is committed.",
    items: [
      {
        name: "Slack",
        icon: brand("slack"),
        body: "Ask @mend in a thread and get the session's status, a preview link and the pull request back.",
        fact: "@mend <request>",
      },
      {
        name: "GitHub",
        icon: brand("github"),
        body: "Push a session's change and open or update its pull request. gh works inside sessions.",
        fact: "mend land · mend connect github",
      },
      {
        name: "Any Git host",
        icon: brand("git"),
        body: "Adopt any repository reachable over SSH or HTTPS, with a Mend key or your SSH agent.",
        fact: "mend adopt <url>",
      },
    ],
  },
  {
    label: "Your environment",
    note: "Sessions start with your setup already in place.",
    items: [
      {
        name: "Dotfiles",
        icon: glyph(FolderSync),
        body: "One command picks up your shell, git and editor config from this machine, and every session starts with it. Keep a dotfiles repo? Point Mend at it and it applies it with stow, chezmoi or a plain copy.",
        fact: "mend dotfiles sync --all",
      },
      {
        name: "Agent skills",
        icon: glyph(Wand2),
        body: "Push your skills library, per person or per project. Every session gets it at launch.",
        fact: "mend skills push",
      },
      {
        name: "Workspace images",
        icon: glyph(Boxes),
        body: "Arch, Ubuntu, Fedora or Nix, or your own OCI image as the base, with any packages you want on top.",
        fact: "arch · ubuntu · fedora · nix · oci",
      },
    ],
  },
  {
    label: "Where it runs",
    note: "Your own hardware, reached over your own network.",
    items: [
      {
        name: "Docker",
        icon: brand("docker"),
        body: "One command sets up the server containers on any machine with Docker.",
        fact: "mend server setup",
      },
      {
        name: "Kubernetes",
        icon: brand("kubernetes"),
        body: "A Helm chart, with sessions in cluster workspaces.",
        fact: "deploy/helm/mend",
      },
      {
        name: "Private network",
        icon: glyph(Network),
        body: "A LAN, a VPN or a tailnet. You declare how the server is reached, and Mend reports what it actually sees.",
        fact: "loopback · private · public",
      },
    ],
  },
];

// ── FAQ ─────────────────────────────────────────────────────────────────────

export const FAQ: ReadonlyArray<{ q: string; a: ReactNode }> = [
  {
    q: "What is Mend?",
    a: (
      <p>
        A self-hosted workbench for coding agents. It keeps all your agent sessions and worktrees on
        one machine you run, and gives each session its own worktree and its own workspace. You
        bring the agent, whether that's Claude Code, Codex, OpenCode, Pi or any other command, and
        reach it from a terminal, VS Code, a browser, your phone or Slack.
      </p>
    ),
  },
  {
    q: "How is this different from hosted cloud agents?",
    a: (
      <p>
        Hosted cloud agents run on the vendor's machines, usually in a fresh sandbox, and you mostly
        see the result. With Mend the agent runs on hardware you pick. The session is a live
        terminal you can attach to and type into while it works. It starts with your dotfiles, your
        secrets and your git access, and its dev servers show up on your own localhost.
      </p>
    ),
  },
  {
    q: "How is this different from OpenCode or T3 Code?",
    a: (
      <>
        <p>
          Those are the tools you work with an agent in. Mend sits a layer below them. It decides
          where your sessions run, keeps all of them on one machine, gives each one its own worktree
          and workspace, and lets you reach any of them from anywhere. Mend already runs OpenCode as
          one of its agents with <code>mend opencode</code>.
        </p>
        <p>
          We're also planning to support Mend as a backend for T3 Code very soon. You'd keep T3 Code
          as your interface, and the sessions would run remotely on your Mend server.
        </p>
      </>
    ),
  },
  {
    q: "Does it replace Claude Code or Codex?",
    a: (
      <p>
        No. The agent runs unchanged in its own terminal, on your own login. Mend starts it in a
        worktree, records it, and gives you ways back in. <code>mend resume --with</code> moves a
        conversation between Claude Code and Codex.
      </p>
    ),
  },
  {
    q: "What do I need to run it?",
    a: (
      <>
        <p>
          Node.js 22 or newer, or 26 if you want the terminal dashboard. The machine that hosts the
          server needs Docker. It runs on Linux and macOS.
        </p>
        <p>
          Install with <code>{INSTALL_COMMAND}</code>, then run <code>mend server setup</code>. The{" "}
          <a href={DOCS_INSTALL_URL}>install guide</a> covers the rest.
        </p>
      </>
    ),
  },
  {
    q: "Can I work in VS Code?",
    a: (
      <>
        <p>
          Yes. The Mend extension lists your projects and sessions in the activity bar. Opening one
          connects VS Code to the session's workspace over Remote-SSH, so the integrated terminal
          runs inside the workspace, and Mend records a <code>claude</code> or <code>codex</code>{" "}
          you start there. It can also take over a session that's running somewhere else and resume
          the conversation in the editor's terminal.
        </p>
        <p>
          It's published on the VS Code Marketplace. Search for Mend in the Extensions view to
          install it.
        </p>
      </>
    ),
  },
  {
    q: "How much does it cost?",
    a: (
      <p>
        Nothing. Mend is open source under the Apache-2.0 license, and there is no hosted service to
        pay for. You bring the machine and your own agent subscriptions.
      </p>
    ),
  },
  {
    q: "Where does my code run, and what leaves my machine?",
    a: (
      <p>
        Sessions run in containers on your Mend server. Mend has no telemetry and uploads no code.
        Your agent talks to its model provider as it always does. Slack and GitHub only come into it
        when you connect them.
      </p>
    ),
  },
  {
    q: "Does Mend use AI itself?",
    a: (
      <p>
        Yes, in a few places. Mend uses inference to name sessions, read a change and draft review
        comments, write summaries, and work out what a Slack request is asking. It runs on the
        Claude or Codex account you connected. Mend ships no model keys and has no model of its own.
        Its comments are drafts, and nothing goes to the agent until you send it.
      </p>
    ),
  },
  {
    q: "Do I need GitHub?",
    a: (
      <p>
        No. Mend adopts any Git repository reachable over SSH or HTTPS, and review works on the
        local change before anything is committed. GitHub comes in when you want <code>gh</code>{" "}
        inside sessions, or want Mend to push a branch and open a pull request.
      </p>
    ),
  },
  {
    q: "Will Mend merge my pull requests?",
    a: (
      <p>
        No. <code>mend land</code> pushes the session's change to a branch on origin and opens or
        updates a pull request. It never merges, never force-pushes, and never moves the session's
        own branch. It reports what was pushed and what GitHub last said, for example{" "}
        <code>pull request #412 · open · observed</code>.
      </p>
    ),
  },
  {
    q: "Can I use it from my phone?",
    a: (
      <p>
        Yes. <code>mend pair</code> prints a QR code. Scan it and your sessions, the live terminal
        and the review open in the phone's browser. The phone has to reach the server, usually over
        a private network. The <a href={DOCS_REMOTE_URL}>remote access guide</a> covers the setups.
        The iOS and Android apps are in review on the App Store and Google Play now.
      </p>
    ),
  },
  {
    q: "Can my team share one instance?",
    a: (
      <p>
        Yes. The first account owns the instance and invites the rest with <code>mend invite</code>.
        Each person connects their own Claude, Codex and GitHub accounts. A project is private to
        whoever made it or shared with everyone, and only a session's owner can type into it unless
        they turn on shared control. For bigger teams there's a{" "}
        <a href={DOCS_KUBERNETES_URL}>Kubernetes deployment</a>.
      </p>
    ),
  },
  {
    q: "Can I put it on the public internet?",
    a: (
      <p>
        We'd rather you didn't. Mend listens on loopback by default and is meant to be reached over
        a LAN, a VPN or a tailnet. There is a public mode, but it refuses to start while its
        exposure checklist has open items. The checklist shows what you declared next to what Mend
        actually observed.
      </p>
    ),
  },
  {
    q: "How does Mend relate to Sealant?",
    a: (
      <p>
        Sealant is the runtime underneath. It runs the workspaces and writes each session's record.
        Mend talks to it only through its public SDK. Sealant ships inside Mend's server image, so
        you install and upgrade Mend alone.
      </p>
    ),
  },
];

// ── shared chrome ───────────────────────────────────────────────────────────

export function Cmd({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[0.9em] text-foreground">{children}</code>;
}
