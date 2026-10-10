import { REPLACE_WORKSPACE_ACTION, sharedControlConfirm } from "@mend/domain/workbench";

/**
 * The command catalog: one record per command, and every help surface renders
 * from it. `mend help` is the index, `mend help <command>` (or `<command>
 * --help`) is one page, `usage:` lines in errors quote the same synopsis, and
 * `man mend` / `mend man <command>` are the same pages as roff. Copy lives
 * here once, so a flag added to a command shows up everywhere or nowhere.
 */

export type Section =
  | "start"
  | "sessions"
  | "services"
  | "project setup"
  | "organization"
  | "this machine";

export const SECTIONS: ReadonlyArray<Section> = [
  "start",
  "sessions",
  "services",
  "project setup",
  "organization",
  "this machine",
];

export interface OptionDoc {
  readonly flag: string;
  readonly text: string;
}

export interface ExampleDoc {
  readonly command: string;
  readonly text: string;
}

export interface CommandDoc {
  /** The words after `mend`, e.g. "service run". */
  readonly name: string;
  /** Other first words that reach the same code, e.g. claude for codex. */
  readonly aliases?: ReadonlyArray<string>;
  readonly section: Section;
  /** One line for the index. Under 60 characters, lowercase, no period. */
  readonly summary: string;
  /** One or more usage shapes; each is printed after `mend <name> `. */
  readonly synopsis: ReadonlyArray<string>;
  /** Paragraphs. Plain sentences; the renderer wraps them. */
  readonly description: ReadonlyArray<string>;
  readonly options?: ReadonlyArray<OptionDoc>;
  readonly examples?: ReadonlyArray<ExampleDoc>;
  /** Other commands worth reading next, by name. */
  readonly see?: ReadonlyArray<string>;
  /** Kept out of the index and man index (the installer's renderer). */
  readonly hidden?: boolean;
}

const project = (what = "the project"): OptionDoc => ({
  flag: "--project <p>",
  text: `${what} by name, when the current directory is not inside it`,
});

const sessionArg =
  "With no id, the one live session is taken; with several, a picker opens. A prefix of the id is enough.";

const tunnelText =
  "On a server that is not this machine, the session's live Services declared --http or --https are tunneled to this machine's loopback while this terminal is attached, on the Service's own port when it is free and on a free one when it is not. One line per tunnel says where it opens, for example web → http://localhost:5173. A Service that stops closes its tunnel, and detaching closes them all. The Services keep running.";

const noTunnel: OptionDoc = {
  flag: "--no-tunnel",
  text: "do not tunnel the session's Services to this machine",
};

export const COMMANDS: ReadonlyArray<CommandDoc> = [
  // ── start ──────────────────────────────────────────────────────────────
  {
    name: "login",
    section: "start",
    summary: "sign this terminal in through the browser",
    synopsis: ["[--url <server>]"],
    description: [
      "Opens <server>/authorize in your browser. You press Authorize there. The CLI saves a device token to ~/.config/mend/cli.json with mode 0600. No password is typed in the terminal, and the token can be revoked from the server at any time.",
    ],
    options: [
      {
        flag: "--url <server>",
        text: "the Mend server. Default: MEND_URL, then http://localhost:3105",
      },
    ],
    examples: [
      { command: "mend login --url http://10.0.0.216:3105", text: "sign in to a LAN server" },
    ],
    see: ["logout", "pair", "doctor"],
  },
  {
    name: "connect",
    section: "start",
    summary: "send this machine's provider credential to the platform",
    synopsis: [
      "<claude|codex|github> [--use-my-login] [--from-stdin] [--remove]",
      "pi [--dir <path>] [--dry-run] [--remove]",
    ],
    description: [
      "Sessions run on the platform, so the platform needs your provider login. It is stored under your own user and used only for your work. Nothing is shared with other users.",
      "Claude and Codex get a login of Mend's own. Both rotate their refresh token, so two copies of one login fight and the one that refreshes second is signed out, and Mend's server refreshes on a schedule. So this logs in through the provider's own flow and your own login stays as it is: Claude in the browser, Codex with a device code, both sent and not kept here. Run it again whenever Mend says a login needs reconnecting. GitHub sends gh's token.",
      "In a per-person workspace each person's processes use their own GitHub login, in their own home: git over HTTPS to GitHub reads it through Mend's credential helper, and no GITHUB_TOKEN is set in the environment. A command that needs the token takes it for itself: GITHUB_TOKEN=$(/run/mend/bin/mend-git-credential token) <command>.",
    ],
    options: [
      {
        flag: "--use-my-login",
        text: "claude, codex: send the login this machine already uses; both sides then share it",
      },
      { flag: "--from-stdin", text: "paste a credential instead of reading the provider's file" },
      { flag: "--remove", text: "disconnect the provider" },
    ],
    examples: [
      { command: "mend connect claude", text: "a Claude login of Mend's own, through the browser" },
      { command: "mend connect codex", text: "a Codex login of Mend's own, with a device code" },
      { command: "mend connect github --remove", text: "" },
    ],
    see: ["accounts", "connect pi"],
  },
  {
    name: "connect pi",
    section: "start",
    summary: "send your pi setup to every pi session of yours",
    synopsis: ["[--dir <path>] [--dry-run] [--remove]"],
    description: [
      "Reads pi's agent directory on this machine (~/.pi/agent, or $PI_CODING_AGENT_DIR) and saves it as your pi profile: extensions, themes, prompt templates, settings, mcp.json and keybindings. Every pi session you start receives it, and before pi starts the session installs the packages settings.json declares and what your extensions import. A package that fails to install is left out of that session, and the terminal says why.",
      "Links are followed, so a setup a tool such as Home Manager links in is read as the files it points at. A package settings.json names by local path is copied into the profile. Your login stays here: pi runs on the ChatGPT login mend connect codex makes. Skills go with mend skills push. Run it again after you change your setup; sessions already running keep the profile they started with.",
    ],
    options: [
      { flag: "--dir <path>", text: "read another agent directory" },
      { flag: "--dry-run", text: "say what would be sent, and send nothing" },
      { flag: "--remove", text: "delete the saved profile" },
    ],
    examples: [{ command: "mend connect pi --dry-run", text: "what your pi profile would hold" }],
    see: ["connect", "skills push"],
  },
  {
    name: "adopt",
    section: "start",
    summary: "adopt a repository into the store",
    synopsis: ["[git-url] [--name <name>] [--auth ambient|mend-key|bridge] [--private|--shared]"],
    description: [
      "Clones a network Git repository into Mend's store. Every session then gets its own worktree of it. With no argument, Mend uses the current checkout's origin URL. HTTP(S), SSH, git://, and SCP-style URLs work; local paths and file:// URLs do not.",
      "--auth says how the store fetches from the remote. Default: your mode from mend keys mode. mend-key signs with your Mend key on the server (see mend keys). bridge relays this machine's ssh-agent while a mend command runs here, so hardware keys stay on your desk. ambient uses the server's own credentials.",
    ],
    options: [
      { flag: "--name <name>", text: "the project's name in Mend. Default: the repository's" },
      { flag: "--auth <mode>", text: "mend-key, bridge, or ambient. Default: mend keys mode" },
      { flag: "--private", text: "only you see the project. Default" },
      {
        flag: "--shared",
        text: "everyone in your organization sees it and can start sessions in it",
      },
    ],
    examples: [
      { command: "mend adopt", text: "the current repository's origin URL" },
      { command: "mend adopt git@github.com:acme/api.git --auth mend-key", text: "" },
    ],
    see: ["keys init", "keys share", "refresh"],
  },
  {
    name: "codex",
    aliases: ["claude", "opencode", "pi"],
    section: "start",
    summary: "launch codex, claude, opencode or pi in a recorded worktree",
    synopsis: [
      '["prompt"] [--name <worktree>] [--worktree <existing>] [--model <id>] [--effort <level>] [--base <ref>] [--ask] [--fast] [--detach|-d] [--foreground] [--no-tunnel] [--land|--no-land] [--project <p>]',
    ],
    description: [
      "mend codex, mend claude, mend opencode and mend pi are the same command with a different harness. The session runs in a workspace on the platform, in its own git worktree, and everything it does is recorded. This terminal attaches to it.",
      "The worktree's name is asked first. --name skips the ask; an existing name joins that worktree as a new session. --worktree joins only and fails if the name is unknown. A quoted prompt becomes the first message.",
      "When another person's session is running in the worktree you join, the launch says so before the session starts: you share its workspace, everything you run runs as you, on your own logins, and either of you can read the other's files, logins included.",
      "Detach with Ctrl+] and the session keeps running. Reattach from any terminal with mend attach, or from the phone.",
      tunnelText,
      "Ctrl+V with an image on this machine's clipboard sends the image to the session and pastes its path; codex and claude read it. Needs wl-paste on Wayland, xclip on X11, nothing extra on macOS.",
      "--land and --no-land decide for this session alone whether Mend lands the change when a turn completes. Without them the session follows the project's Land when a turn completes setting, which is off unless someone turned it on, and a project set to off wins over --land. Mend lands after turns it runs itself, so an agent attached to this terminal lands on its own only once the session is picked up on the phone. From here, land it with mend land.",
    ],
    options: [
      { flag: "--name <worktree>", text: "name the worktree; an existing name joins it" },
      { flag: "--worktree <existing>", text: "join an existing worktree only" },
      {
        flag: "--model <id>",
        text: "the harness's model id, one mend models lists. Default: the server's default for the harness",
      },
      {
        flag: "--effort <level>",
        text: "low, medium, high, xhigh, max, or ultra where the model takes it. Default: the harness's own",
      },
      { flag: "--base <ref>", text: "the branch or sha the worktree starts from" },
      { flag: "--ask", text: "keep the harness's permission prompts" },
      { flag: "--fast", text: "priority processing where the harness offers it (codex)" },
      { flag: "--detach, -d", text: "launch without attaching" },
      { flag: "--foreground", text: "stop the session when this CLI exits" },
      noTunnel,
      {
        flag: "--land, --no-land",
        text: "land, or do not land, when a turn completes. Default: the project's setting",
      },
      project(),
    ],
    examples: [
      {
        command: 'mend claude "add a health endpoint"',
        text: "asks for a worktree name, then runs",
      },
      { command: "mend codex --name auth-rework -d", text: "start in the background" },
      {
        command: "mend codex --worktree auth-rework",
        text: "a second session in the same worktree",
      },
    ],
    see: ["attach", "stop", "run", "sessions", "land", "models"],
  },
  {
    name: "models",
    section: "start",
    summary: "the models each harness offers, as the server lists them",
    synopsis: ["[--json]"],
    description: [
      "One block per harness: each model's id, the one a launch runs when --model is not given, and the efforts a model takes where they are fewer than the harness's. The list is the server's; the phone, the web app, the desktop and VS Code offer the same one, and a session records which model it was started with.",
      "Pass an id to mend claude or mend codex with --model. An id the list does not know is passed through as given; the harness decides whether it exists.",
    ],
    options: [{ flag: "--json", text: "the catalog as the server answers it" }],
    examples: [
      { command: "mend models", text: "" },
      { command: 'mend codex "fix the flaky test" --model gpt-6-astra --effort ultra', text: "" },
    ],
    see: ["codex", "sessions"],
  },
  {
    name: "pair",
    section: "start",
    summary: "pair a phone or a second machine",
    synopsis: ["[--url <base url>]"],
    description: [
      "Prints a QR code, the code itself, and the URL this server is reached at. The pairing is for one device, once, and expires after 10 minutes.",
    ],
    options: [
      { flag: "--url <base url>", text: "the address the other device should use for this server" },
    ],
    see: ["login"],
  },
  {
    name: "doctor",
    section: "start",
    summary: "check this machine's setup, or bundle it for a bug report",
    synopsis: ["", "--bundle [--out <path>] [--tail <n>]"],
    description: [
      "Read-only. One line per fact: the server, the sign-in, the platform connection, the provider accounts, the git key, and where docker is on PATH its daemon's shutdown-timeout against the capture grace. Each unfinished line ends with the command that fixes it.",
      "--bundle collects what a maintainer asks for one output at a time into one tar.gz: this CLI and its environment, the doctor lines, the server's health, the local server's configuration (its compose file and the names of its .env keys, never their values), docker version, info, contexts, the Mend and workspace containers with their inspect facts, the local server's container logs, the running workspace containers' logs, every session with its processes, exit codes and argv, the recorded terminal output of each, the connected accounts, and the versions and paths of claude, codex, gh, git and docker on this machine.",
      "Each part is collected on its own: one that fails leaves a <name>.error.txt in the bundle instead of stopping it. One redactor runs over every file before it is written: bearer and header values, Slack, OpenAI, GitHub and AWS token shapes, JWTs, passwords in URLs, and any password, secret or token value. The archive is written with mode 0600. It still contains logs and configuration; read it before you share it.",
    ],
    options: [
      { flag: "--bundle", text: "write the diagnostic archive instead of printing the checklist" },
      {
        flag: "--out <path>",
        text: "where the archive goes. Default: ~/.config/mend/bundles/mend-bundle-<time>.tgz",
      },
      {
        flag: "--tail <n>",
        text: "lines per container log and per recorded process, 1..2000. Default: 500",
      },
    ],
    examples: [
      { command: "mend doctor", text: "the checklist" },
      { command: "mend doctor --bundle", text: "one archive to attach to a bug report" },
    ],
    see: ["login", "connect", "keys init", "server logs"],
  },

  // ── sessions ───────────────────────────────────────────────────────────
  {
    name: "ui",
    section: "sessions",
    summary: "the dashboard: every project and session, live",
    synopsis: ["[--no-tunnel]"],
    description: [
      "A full-screen view of every project and session, updating live. The session pane takes three quarters of the screen: a read-only detail for the selected session with the conversation record it has written so far. The remaining quarter is a sidebar of three stacked sections, projects then worktrees then sessions, where the section you are in stands open and the other two fold to the line that says what is selected. Bare mend with no command opens the same thing.",
      "Every pane carries its number in its title, as lazygit's do: [1] projects, [2] worktrees, [3] sessions, and [0] the session pane. A digit jumps to its pane, tab and Shift+Tab cycle through them and come back round, and esc goes back to where you came from. ? lists every key, / filters the focused list (enter keeps the filter, esc clears it), and + and _ cycle the screen mode: normal, half (the sidebar takes half the width) and full (the side you are on takes the screen).",
      "Moving the selection only ever navigates: arrows or j/k move inside the open section, enter and the arrows move between the sidebar and the session pane, and nothing takes this terminal until you ask. Reading the record leaves the sidebar as it was. The verbs are a to attach a live session, r to resume a settled one, n for another session in the selected worktree, w for a new worktree, e to rename, v to review the change, o to open it in the browser, Shift+K to stop (on a row whose agent has stopped while its Services keep the workspace up, Shift+K stops those Services), Shift+D to remove, and Shift+R to refresh.",
      "Nothing is ever squeezed. A terminal too narrow for both gives the whole width to the side you are on, a terminal too short for three drawn panes shows the open section alone, and a one-line breadcrumb states whatever did not fit.",
      "On a server that is not this machine, the selected session's live Services declared --http or --https are tunneled to this machine's loopback while it stays selected, and the session pane shows where each one opens, for example web → http://localhost:5173.",
      "The dashboard needs Node 26 or newer for its terminal. Every other command works on Node 22.",
    ],
    options: [noTunnel],
    see: ["sessions", "attach"],
  },
  {
    name: "snake",
    section: "sessions",
    summary: "the dashboard, with snake over it",
    synopsis: [],
    description: [
      "Opens the dashboard with a game of snake floating over it. It counts down 3, 2, 1, go before the snake moves. The arrows or h j k l steer, space or p pauses (and counts down again to resume), and esc or q closes the game and leaves you in the dashboard, which has been live underneath the whole time. The same game appears in the session pane while a session is starting: a first session on a new project setup builds its image before it boots, about seven minutes on some families. A start or resume from the dashboard hands the game the keyboard, as does enter or → into that pane; esc or q gives it back to the list you were in.",
      "Needs Node 26 or newer, like the dashboard.",
    ],
    see: ["ui"],
  },
  {
    name: "attach",
    section: "sessions",
    summary: "reattach this terminal to a running session",
    synopsis: ["[session-id-prefix] [--no-tunnel]"],
    description: [
      sessionArg,
      "A session that was picked up on the phone is taken back into this terminal: the phone's agent ends and the same conversation continues here.",
      tunnelText,
      "Ctrl+V with an image on this machine's clipboard sends the image to the session and pastes its path; codex and claude read it. Needs wl-paste on Wayland, xclip on X11, nothing extra on macOS.",
    ],
    options: [noTunnel],
    see: ["stop", "rejoin", "shell", "service connect"],
  },
  {
    name: "stop",
    section: "sessions",
    summary: "stop the agent; the record and the review remain",
    synopsis: ["[session-id-prefix]", "--all [--project <p>]", "--services [session-id-prefix]"],
    description: [
      "Ends the agent process. The workspace harvests the harness state and closes. The worktree, the record, and the review stay, and mend resume brings the conversation back.",
      "Services keep running after a stop, and a running Service keeps the workspace up. The stop then prints, for example, agent stopped · 3 services keep the workspace up. --services stops all of them. Once nothing is live, the workspace closes.",
      sessionArg,
    ],
    options: [
      { flag: "--all", text: "every live session" },
      project("limit --all to one project"),
      { flag: "--services", text: "stop the session's Services instead of its agent" },
    ],
    see: ["resume", "attach"],
  },
  {
    name: "shell",
    section: "sessions",
    summary: "open a shell in a live session's workspace",
    synopsis: ["[session-id-prefix]"],
    description: [
      "A second terminal into the same workspace the agent works in, beside it. Useful for running the tests yourself or looking at a file.",
      sessionArg,
    ],
    see: ["attach", "service run"],
  },
  {
    name: "run",
    section: "sessions",
    summary: "run any command as a session",
    synopsis: [
      "[--project <p>] [--name <n> | --worktree <n>] [--base <ref>] [--detach] [--json] -- <command...>",
    ],
    description: [
      "The same worktree, record, and review as mend codex, with a command of your own in place of a harness. Everything after -- is the command.",
      "The command's output is printed as the record has it, and mend run exits with the command's exit code. It runs in a terminal, so stdout and stderr arrive together, on stdout. What Mend says itself goes to stderr, so out=$(mend run -- git log -1) holds the command's output and nothing else. Ctrl+C stops watching and puts the terminal back; the command keeps running, and mend logs and mend wait pick it up again. A signal exits 128 + its number: 130 for SIGINT (Ctrl+C), 129 for SIGHUP, 143 for SIGTERM. A second signal exits at once, and an exit waits at most 5 seconds for a reader that takes nothing, then says the output may be incomplete.",
      "Output this terminal could not be given in full (a read the server refused, a reader that went away) fails mend run with exit 1 even when the command succeeded, and the command's own code is said on stderr: a script never takes cut output for the whole of it.",
      "The platform takes at most 64 words and 1 MiB, at most 131,071 bytes a word, a program with no leading or trailing whitespace, and no NUL byte. An argument may be empty, start with a newline or span lines. A command it would refuse is refused before anything is created.",
      "With --detach, mend run returns once the command runs. With --json, stdout carries one JSON object in place of the output: the session id, the process id, the worktree, the branch, and the process's status and exit code as last observed, which is how it ended without --detach (and with it, when the command ended first).",
      "Workspaces set PAGER=cat, so git log and friends print instead of waiting for a pager the image does not have. A project variable of the same name, or the pager in your own git config, wins.",
    ],
    options: [
      project(),
      { flag: "--name <n>", text: "name the worktree; an existing name joins it" },
      { flag: "--worktree <n>", text: "join an existing worktree only" },
      { flag: "--base <ref>", text: "create the worktree from another git base" },
      { flag: "--detach, -d", text: "return once the command runs" },
      { flag: "--json", text: "print the session and process ids, and the end, as JSON" },
    ],
    examples: [
      { command: "mend run -- pnpm test", text: "the test output here, exit code included" },
      {
        command: "id=$(mend run --detach --json -- make build | jq -r .sessionId)",
        text: "start it, then mend wait $id",
      },
    ],
    see: ["logs", "wait", "codex"],
  },
  {
    name: "logs",
    section: "sessions",
    summary: "print a session's recorded terminal output",
    synopsis: [
      "[session] [--follow] [--from <sequence>] [--process <id>]",
      "[session] --service <name-or-id> [--follow] [--from <sequence>]",
    ],
    description: [
      "Prints what the session's command (or agent) wrote to its terminal, as the record holds it, on stdout. Settled sessions count: the record outlives the process and the workspace. --follow keeps printing until the process ends. The record is printed as it is, nothing taken out: anyone who can read the project can read it, so what a command printed, a password included, reaches them too. A signal stops it and puts the terminal back, exiting 128 + its number: 130 for SIGINT (Ctrl+C), 129 for SIGHUP, 143 for SIGTERM.",
      "<session> is the session id, a prefix of it, or the worktree's name. With none, the one live session is taken. --process reads another process of the session, a shell or a Service attempt, by a prefix of its id; a Service's id or name there reads the Service's current attempt.",
      "--service reads a Service's current attempt, by the Service's id, its name or a prefix of its id, the ids mend service list prints. A full id names its Service before any name does. A name two Services carry is refused, with both ids listed; name one by its id, or name the session. A Service with no attempt (an adopted port, which Mend runs no process for) has nothing recorded, and mend logs says so and exits 1.",
    ],
    options: [
      { flag: "--follow, -f", text: "keep printing until the process ends" },
      { flag: "--from <sequence>", text: "start at a record sequence. Default: 0" },
      { flag: "--process <id>", text: "another process of the session, by a prefix of its id" },
      { flag: "--service <name-or-id>", text: "a Service's current attempt" },
    ],
    examples: [
      { command: "mend logs 3f2a --follow", text: "" },
      { command: "mend logs --service web --follow", text: "the Service web's output, live" },
    ],
    see: ["run", "wait", "service logs"],
  },
  {
    name: "wait",
    section: "sessions",
    summary: "wait for a session's command to end",
    synopsis: ["[session] [--timeout <duration>] [--process <id>] [--json]"],
    description: [
      "Returns once the session's command (or agent) has ended, with its exit code: the code the platform reported, or 1 when it reported none. A command that already ended answers at once. While a launch or a resume is starting, the previous process's end does not count. --process waits for one process by its id, the processId mend run --json prints.",
      "A session that is still starting (its workspace building, its image pulling) is waited through: only its end counts. When --timeout passes first, mend wait exits 124, as timeout(1) does, and the command keeps running. A duration is seconds (90, 90s or .5), minutes (5m) or hours (1h); with none, mend wait waits as long as the command runs. Stopped by a signal, it exits 128 + its number (130 for Ctrl+C), and the command keeps running. The timeout covers everything: finding the session, every read and every retry. --json then prints the last state read, and nothing more is asked of the server.",
      "<session> is the session id, a prefix of it, or the worktree's name. With none, the one live session is taken.",
    ],
    options: [
      { flag: "--timeout <duration>", text: "give up after this long (90, 90s, 5m, 1h); exit 124" },
      {
        flag: "--process <id>",
        text: "wait for this process of the session, by a prefix of its id",
      },
      { flag: "--json", text: "print the session, the process, the status and the exit code" },
    ],
    examples: [{ command: "mend wait 3f2a --timeout 600", text: "" }],
    see: ["run", "logs"],
  },
  {
    name: "continue",
    section: "sessions",
    summary: "resume a session with its pending review follow-up",
    synopsis: ["[session-id]"],
    description: [
      "The review comments you sent to the session become its first message. With no id, the newest session with a pending follow-up is taken.",
    ],
    see: ["resume", "sessions"],
  },
  {
    name: "resume",
    section: "sessions",
    summary: "rejoin a settled session with its state restored",
    synopsis: ["[session-id] [--with <harness>]"],
    description: [
      "Starts a new agent process from the saved harness state, so the conversation continues where it stopped. --with switches the harness; the conversation carries over between claude and codex.",
    ],
    options: [
      { flag: "--with <harness>", text: "claude or codex; default: the one the session used" },
    ],
    see: ["stop", "rejoin"],
  },
  {
    name: "rejoin",
    section: "sessions",
    summary: "attach if live, otherwise resume",
    synopsis: ["[session-id] [--harness <h>] [--no-tunnel]"],
    description: [
      "With no id, the newest live session wins; failing that, the newest settled one.",
      "Tunnels the session's browser Services to this machine while attached, as mend attach does.",
    ],
    options: [
      { flag: "--harness <h>", text: "the harness to resume with, when resuming" },
      noTunnel,
    ],
    see: ["attach", "resume"],
  },
  {
    name: "sessions",
    aliases: ["status"],
    section: "sessions",
    summary: "sessions with their review facts",
    synopsis: ["[--all] [--project <p>] [--json | --json=v2]"],
    description: [
      "One line per session: harness, worktree, status, and what the review found. Live sessions by default.",
      "Under a live session, a line each when there is something to say about its workspace: who else is live in it (Shared workspace with Anna), the waiting line while a turn waits for another person's work, and the line of a workspace that started before Mend 0.36 and waits to be replaced. The change's owner also reads how to replace it, and what would stop.",
      "The JSON is stable for integrations. --json is the v1 flat list; --json=v2 groups sessions by worktree, the same shape mend worktrees prints.",
    ],
    options: [
      { flag: "--all", text: "settled sessions too" },
      project(),
      { flag: "--json", text: "the v1 flat list" },
      { flag: "--json=v2", text: "grouped by worktree" },
    ],
    see: ["worktrees", "projects"],
  },
  {
    name: "worktrees",
    section: "sessions",
    summary: "every worktree and the sessions inside it",
    synopsis: ["[--project <p>] [--json]"],
    description: ["A worktree can hold several sessions over time; this shows them together."],
    options: [project(), { flag: "--json", text: "the v2 grouped shape" }],
    see: ["sessions", "worktrees rm"],
  },
  {
    name: "worktrees rm",
    section: "sessions",
    summary: "remove a worktree, its sessions and its change",
    synopsis: ["<name> [--force] [--project <p>]"],
    description: [
      "Removes the worktree directory from the store, with every session in it, its change, its checkpoints and its review. Nothing on origin is touched. <name> is the worktree's name as mend worktrees lists it.",
      "Refused while a session in it is live: the command names the sessions and the stops that free them. Refused while it holds a change that is not on origin, one never landed or one changed since its last landing: the refusal names the files and line counts, in the server's words. Land it with mend land, or pass --force to remove it anyway. A worktree whose workspace is still saving is refused until the save ends, and --force does not change that.",
    ],
    options: [
      { flag: "--force", text: "remove it although its change is not on origin" },
      project(),
    ],
    examples: [
      { command: "mend worktrees rm fix-login", text: "refused when its change was never landed" },
      { command: "mend worktrees rm fix-login --force", text: "remove it anyway" },
    ],
    see: ["worktrees", "land", "stop"],
  },
  {
    name: "workspace replace",
    section: "sessions",
    summary: "replace a workspace that started before Mend 0.36",
    synopsis: ["<session> [--yes]"],
    description: [
      `${REPLACE_WORKSPACE_ACTION}, from a terminal. A workspace that shares one home, as every workspace started before Mend 0.36 does, takes only its launcher's sessions and turns once its worktree runs each person as themselves, until it is replaced. Mend replaces it on its own when nothing would stop; otherwise the change's owner does, here or on the web.`,
      "It prints what was checked, and when: Mend's records, and the processes in the workspace and its running containers once they have been checked. Then what would stop, one line each: terminal sessions (they end resumable), shells, Services started by hand, processes Mend did not start, running containers and anything that could not be checked. Mend starts the launching session's mend.toml Services again.",
      "The replacement names what it showed you: when more would stop by the time you answer, the server refuses, nothing is stopped, and its words are printed as they are; run it again to look at the list again. An agent turn in flight is never stopped: the server refuses the same way. The workspace goes once its last save is done.",
      "A prefix of the session id is enough. mend sessions shows which sessions wait for this.",
    ],
    options: [{ flag: "--yes", text: "replace without asking; required without a terminal" }],
    examples: [{ command: "mend workspace replace 3f2a", text: "" }],
    see: ["sessions", "stop"],
  },
  {
    name: "projects",
    section: "sessions",
    summary: "adopted projects and their live sessions",
    synopsis: ["[--json]"],
    description: [
      "One line per project, with the sessions running in it.",
      '--json prints them for scripts, stable like mend sessions --json: {"version": 1, "projects": [...]}, an empty list when there are none. Each project has id, name, originUrl (a string, or null), defaultBranch, storePath, liveSessions (a number) and current (true when the current directory is inside it).',
      "A repository URL is printed without its credentials: https://oauth2:TOKEN@github.com/acme/repo.git reads as https://github.com/acme/repo.git, here and in every line, message and JSON the CLI prints itself; an ssh URL keeps its user and loses only the password. A command's recorded output (mend run, mend logs, mend service logs, mend attach) and a file's contents (mend memory show) are printed as they are, and a session's record is readable by anyone who can read the project.",
    ],
    options: [{ flag: "--json", text: "the projects as JSON" }],
    see: ["adopt", "sessions"],
  },
  {
    name: "refresh",
    section: "sessions",
    summary: "fetch origin's branches into the store",
    synopsis: ["[project]"],
    description: [
      "New sessions base on the tips the store holds; this brings them up to date with origin. Default: the project the current directory belongs to.",
    ],
    see: ["adopt"],
  },
  {
    name: "land",
    section: "sessions",
    summary: "push a session's change to origin and open its pull request",
    synopsis: [
      "<session> [--branch <name>] [--no-pr] [--title <text>] [--project <p>]",
      "<session> --check [--project <p>]",
    ],
    description: [
      "Only the change's owner lands it: the owner of the worktree's first session, not someone who started a session in it later. Mend takes a checkpoint, commits what the agent left uncommitted on top of the agent's own commits and the last landing, and pushes that to origin with the project's git access. The agent's commits are pushed as they are. The session's branch, and the worktree's files, index and HEAD, are not touched.",
      "The push only fast-forwards. When origin's branch has commits Mend has not seen, or origin refuses the push, nothing is pushed and the command prints the remote's own words. Mend never force-pushes.",
      "When origin is on GitHub, Mend then opens a pull request into the session's base branch, or updates the one it opened before. That call runs in a workspace with your GitHub account (mend connect github). The description holds Mend's review summary when there is one, the changed files and links back to the session, and an update replaces only Mend's section of it. For any other origin the push happens and the pull request is reported as unavailable, with the reason.",
      "Landing again after more work adds commits to the same branch and updates the same pull request. When nothing is new since the last landing, nothing is pushed and the command says so. The branch on origin is never the project's default branch or the pull request's base. The command then prints what Mend observed: the push, the pull request and its state, what changed since, and pushes the agent made itself. It exits 1 when the push was refused or a step failed.",
      "A pull request someone opened outside Mend, the agent through gh included, is found and recorded as the change's own: Mend looks after the agent pushes a branch and when its turn ends, and --check looks now. It asks GitHub, as you, about the worktree's branch, every branch the agent pushed, and the agent's head commit. A landing then pushes that pull request's branch and updates it. A pull request from a fork is shown and never updated: Mend pushes to origin only, and opens no second pull request beside it.",
      "<session> is a prefix of the session id or the worktree's name. Settled sessions count.",
    ],
    options: [
      {
        flag: "--branch <name>",
        text: "the branch on origin. Default: where the change last pushed to, the branch the agent pushed, an adopted pull request's branch, else mend/<worktree>",
      },
      {
        flag: "--check",
        text: "only look on GitHub for a pull request opened outside Mend, and record it; push nothing",
      },
      { flag: "--no-pr", text: "push only; open or update no pull request" },
      {
        flag: "--title <text>",
        text: "the pull request's title. Default: the session's label; a title edited on GitHub is kept",
      },
      { flag: "--project <p>", text: "look for the session in this project only, by name" },
    ],
    examples: [
      { command: "mend land fix-login", text: "push mend/fix-login and open its pull request" },
      {
        command: "mend land 3f2a --no-pr --branch wip/login",
        text: "push only, to another branch",
      },
    ],
    see: ["pull", "sessions", "connect"],
  },
  {
    name: "pull",
    section: "sessions",
    summary: "fetch a session's change into this clone as mend/<name>",
    synopsis: ["<session> [--force] [--project <p>]"],
    description: [
      "Run it inside a local clone of the project's repository. Mend commits the session's latest checkpoint the way mend land does, without pushing, and sends the commits from the session's base to it as a git bundle. The change's owner gets a checkpoint taken first; anyone else gets the latest one there is, and pulling moves nothing on the server. This command fetches the bundle into a local branch of the same name and prints what it fetched. The working tree, the index and the branch you are on are not touched; switch to the branch when you want it.",
      "It works before the change is landed, and without origin. The clone needs the session's base commit, so fetch from origin first when it is missing. An existing local branch of the same name only fast-forwards. A bundle over the server's size limit (MEND_BUDGET_BUNDLE_BYTES) is refused with its size, and nothing is fetched.",
      "One of the clone's remotes must be the project's origin. They are compared by host and path, so ssh and https spellings match. --force skips the check.",
      "<session> is a prefix of the session id or the worktree's name. Settled sessions count.",
    ],
    options: [
      {
        flag: "--force",
        text: "fetch into a clone whose remotes do not include the project's origin",
      },
      { flag: "--project <p>", text: "look for the session in this project only, by name" },
    ],
    examples: [{ command: "mend pull fix-login", text: "then: git switch mend/fix-login" }],
    see: ["land", "sessions"],
  },

  // ── services ───────────────────────────────────────────────────────────
  {
    name: "service run",
    section: "services",
    summary: "start and supervise a server in the session's workspace",
    synopsis: [
      "[session] --port <port> [--name <n>] [--udp] [--http|--https] [--wait [--timeout <duration>]] [--no-connect] -- <command...>",
      "[session] <name> [--wait [--timeout <duration>]] [--no-connect]",
    ],
    description: [
      "With --, the command after it is started in the workspace and supervised: its output is recorded, and mend service restart re-runs it. Without --, the name is a Service declared in the worktree's mend.toml. mend service <name> is the shorthand for that.",
      "Mend waits up to a minute for the port to answer before it returns. --wait keeps waiting while the Service is still starting (its process runs and its port has not answered yet: building, installing, booting), however long that takes, up to --timeout (default 10 minutes). Mend probes a started Service's port every 20 seconds, so the wait ends at the first probe that answers. The wait judges the one process this start began, by an id the start sends and the server stamps on it, whatever another client starts, restarts or stops meanwhile. The exit status says how it ended: 0 the port answered for that process; 1 Mend refused the start or could not be asked; 2 the process ended before its port answered (the line says its status and exit code; a process its workspace took reads exited, no exit code reported); 3 the server no longer has the session, its workspace gone with it; 124 the Service was still starting when the timeout passed, and it keeps starting. A server older than this CLI stamps no id: a start whose answer an edge cut is then not followed (1), and a command that exits inside the minute reads as the refusal it answers with (1). A waited start returns and opens no tunnel; mend service connect reaches the port. UDP has no probe, and a recipe that declares only a port is adopted with one probe, so --wait takes neither.",
      "The port is tunnelled to this machine's loopback as soon as it listens, unless --no-connect.",
    ],
    options: [
      {
        flag: "--wait",
        text: "return once the port answers: 0; process ended 2, session gone 3; no tunnel",
      },
      {
        flag: "--timeout <duration>",
        text: "bound --wait (90, 90s, 5m, 1h); still starting then exits 124. Default: 10m",
      },
      { flag: "--port <port>", text: "the port the command listens on inside the workspace" },
      { flag: "--name <n>", text: "the service's name. Default: the command" },
      { flag: "--udp", text: "a UDP port" },
      { flag: "--http, --https", text: "how a browser should open it" },
      { flag: "--no-connect", text: "do not tunnel the port to this machine" },
    ],
    examples: [
      { command: "mend service run --port 3000 -- pnpm dev", text: "" },
      { command: "mend service web", text: "the Service named web in mend.toml" },
      {
        command: "mend service run web --wait --timeout 15m",
        text: "returns once web answers; 124 if it is still starting after 15 minutes",
      },
    ],
    see: ["service init", "service connect", "service logs", "logs"],
  },
  {
    name: "service add",
    section: "services",
    summary: "adopt a port something in the workspace already listens on",
    synopsis: ["[session] <port> [--name <n>] [--udp] [--http|--https]"],
    description: [
      "For a server the agent started itself. The port becomes a Service, reachable on this machine like one mend service run started.",
    ],
    options: [
      { flag: "--name <n>", text: "the service's name. Default: the port" },
      { flag: "--udp", text: "a UDP port" },
      { flag: "--http, --https", text: "how a browser should open it" },
    ],
    see: ["service run", "service list"],
  },
  {
    name: "service connect",
    section: "services",
    summary: "bring live Services to this machine's loopback",
    synopsis: ["[name...] [--port <p>]"],
    description: [
      "Each connection tunnels through the server, authenticated as you. With no names, every live Service. Ctrl-C closes them.",
      "mend attach, mend codex, and the dashboard already do this for the attached session's Services declared --http or --https. This command is for the rest: a Service with no browser scheme, one in another session, or a terminal that is not attached.",
    ],
    options: [{ flag: "--port <p>", text: "the local port, when connecting one Service" }],
    see: ["service list"],
  },
  {
    name: "service list",
    section: "services",
    summary: "every live service and its observed state",
    synopsis: ["[--json]"],
    description: [
      "Name, observed state, port, the Service's id and its current attempt's process id, and where it is reachable from here. The process id is what mend logs --process and mend wait --process take; mend logs --service takes the Service's name or id. An adopted port has no process.",
      "With --json, stdout carries one JSON object: version 1, and services, each with id, name, sessionId, processId (null for an adopted port), status as last observed, workspacePort, protocol (tcp or udp), and hostPort, authority and browserUrl (null when not bound).",
    ],
    options: [{ flag: "--json", text: "print the Services as JSON" }],
    see: ["service run", "service connect", "logs"],
  },
  {
    name: "service logs",
    section: "services",
    summary: "follow a supervised service's output",
    synopsis: ["<name-or-id> [--from <sequence>]"],
    description: [
      "Replays the recorded output, then follows it live. Ctrl-C stops following.",
      "The record is printed as it is, nothing taken out, and anyone who can read the project can read it: what the Service printed, a password included, reaches them too.",
    ],
    options: [{ flag: "--from <sequence>", text: "start the replay at a record sequence" }],
    see: ["service run"],
  },
  {
    name: "service restart",
    section: "services",
    summary: "re-run a service's recorded command, same URL",
    synopsis: ["<name-or-id>"],
    description: ["The port and the local address stay the same, so open tabs keep working."],
    see: ["service stop"],
  },
  {
    name: "service stop",
    section: "services",
    summary: "stop a service and close its host port",
    synopsis: ["<name-or-id>"],
    description: ["Ends the process and the tunnel. The record of its output remains."],
    see: ["service restart"],
  },
  {
    name: "service init",
    section: "services",
    summary: "scaffold mend.toml from package.json and compose ports",
    synopsis: ["[--yes]"],
    description: [
      "Writes a mend.toml in the current repository with one Service per script and exposed port it can find. Edit it afterwards; sessions read it from their worktree.",
    ],
    options: [{ flag: "--yes", text: "write without asking" }],
    see: ["service run"],
  },

  // ── project setup ──────────────────────────────────────────────────────
  {
    name: "env show",
    section: "project setup",
    summary: "what the project store holds: names only, never values",
    synopsis: ["[--project <p>]"],
    description: ["Configuration names and secret names for the project. Values never print."],
    options: [project()],
    see: ["env load"],
  },
  {
    name: "env load",
    section: "project setup",
    summary: "load a .env into the project",
    synopsis: ["[file] [--project <p>] [--secret [A,B]]"],
    description: [
      "Ordinary names become configuration. Secret-shaped names (KEY, TOKEN, PASSWORD, and the like) become secrets, which Mend stores encrypted and never shows again. Sessions receive both at launch. Default file: .env in the current directory.",
    ],
    options: [
      project(),
      {
        flag: "--secret [A,B]",
        text: "send every name to secrets, or only the named ones, e.g. DATABASE_URL",
      },
    ],
    examples: [
      { command: "mend env load .env.production --secret DATABASE_URL,STRIPE_KEY", text: "" },
    ],
    see: ["env show", "env cluster"],
  },
  {
    name: "env cluster",
    section: "project setup",
    summary: "bind Kubernetes secrets and configmaps to the workspaces",
    synopsis: [
      "add secret|configmap <name>",
      "remove <kind>/<name>",
      "sa <name> | sa --clear",
      "[--project <p>]",
    ],
    description: [
      "For a Mend server running in Kubernetes. The platform mounts the named objects into the project's workspaces at launch; Mend never reads their contents. sa sets the service account the workspaces run as. Changes apply from the next launch; running workspaces keep what they started with.",
    ],
    options: [project()],
    examples: [
      { command: "mend env cluster add secret app-env", text: "" },
      { command: "mend env cluster remove secret/app-env", text: "" },
    ],
    see: ["env load"],
  },
  {
    name: "skills",
    section: "project setup",
    summary: "your skill library on the server, or a project's",
    synopsis: ["[list] [--project [p]]"],
    description: [
      "Skills are instruction bundles the harness loads at launch. Yours apply to every session; a project's apply to sessions in that project.",
    ],
    options: [{ flag: "--project [p]", text: "the project's library instead of yours" }],
    see: ["skills push"],
  },
  {
    name: "skills push",
    section: "project setup",
    summary: "upload ~/.agents/skills into the library",
    synopsis: ["[--project [p]] [--prune] [--dir <path>]"],
    description: [
      "Scans the directory codex and claude read skills from and uploads every bundle. Sessions receive the library at launch. Unchanged bundles are skipped.",
    ],
    options: [
      { flag: "--project [p]", text: "push into the project's library instead of yours" },
      { flag: "--prune", text: "remove server-side skills the directory no longer has" },
      { flag: "--dir <path>", text: "scan another directory. Default: ~/.agents/skills" },
    ],
    see: ["skills"],
  },
  {
    name: "memory",
    section: "project setup",
    summary: "what the agents remember about a project, for you",
    synopsis: [
      "[list] [--project <p>]",
      "show <file> [--project <p>]",
      "rm <file> [--project <p>]",
    ],
    description: [
      "Claude Code and Codex write what they learn about a repository to their memory. Mend keeps that memory per person per project: every session you start on the project receives it, and what the agent learned is saved back when it ends. When two of your sessions change the same text file, both sides' lines are kept.",
      "Codex builds its memory from your past conversations when a session starts, with model calls on your own login. Mend carries your earlier Codex conversations on the project into each new session so it has some to learn from.",
      "This lists your memory for the project, prints one file, or removes one. Removing keeps the last version on the server. Other people's sessions never see it.",
    ],
    options: [project()],
    examples: [
      { command: "mend memory", text: "your memory for the project in this directory" },
      { command: "mend memory show MEMORY.md", text: "Claude's index of what it remembers" },
    ],
    see: ["memory import"],
  },
  {
    name: "memory import",
    section: "project setup",
    summary: "bring this machine's claude and codex memory for the repository",
    synopsis: ["[--project <p>] [--dry-run]"],
    description: [
      "Run inside the repository's checkout. Reads the memory Claude Code keeps on this machine for that directory, and the summaries Codex made of conversations held in it. Codex keeps one memory for everything, so only its summaries of this repository's conversations are read, never its consolidated memory. Transcripts, logins and settings are not read.",
      "A file Mend does not have is added. A file both sides have with other contents is merged, keeping both sides' lines (a line both wrote at different places stays twice), and a note's frontmatter is merged key by key, with this machine's value kept as a comment where the two differ. Mend remembers what it imported from this checkout on this machine, so the next import from here takes whichever side changed since and merges only what both changed. A file Mend removed since then is not added again. A file it cannot merge stays as Mend has it, and this machine's is kept as a version, as it is when a merge does not hold every line this machine sent. Every version Mend replaces is kept.",
    ],
    options: [
      project(),
      { flag: "--dry-run", text: "show what the import would do, and write nothing" },
    ],
    examples: [{ command: "mend memory import --dry-run", text: "" }],
    see: ["memory", "adopt"],
  },
  {
    name: "memory show",
    section: "project setup",
    summary: "print one memory file",
    synopsis: ["<file> [--project <p>]"],
    description: [
      "Prints the file as Mend stores it, by the name mend memory lists. A name alone is Claude's; prefix another harness's with its name, as in codex:MEMORY.md.",
    ],
    options: [project()],
    see: ["memory"],
  },
  {
    name: "memory rm",
    section: "project setup",
    summary: "remove one memory file",
    synopsis: ["<file> [--project <p>]"],
    description: [
      "Removes the file from your memory for the project. Sessions already running keep their copy; the next launch does not deliver it, and a session that still holds it unchanged moves it aside. The last version stays on the server.",
    ],
    options: [project()],
    see: ["memory"],
  },
  {
    name: "dotfiles",
    section: "project setup",
    summary: "your dotfiles on the server: repo and synced files",
    synopsis: ["[show]"],
    description: [
      "Workspaces apply your dotfiles at launch, from a repository you point the server at or from files mend dotfiles sync captured. This shows what is set, including the manager the repository applies with.",
    ],
    see: ["dotfiles repo", "dotfiles sync"],
  },
  {
    name: "dotfiles repo",
    section: "project setup",
    summary: "set or clear the repository the server clones at launch",
    synopsis: [
      "<url> [--ref <r>] [--subdirectory <d>] [--manager <m>] [--no-bootstrap]",
      "--clear",
    ],
    description: [
      "The server clones the repository as you at every launch and sends its tree to the workspace. Saving tries that clone once; a repository it cannot clone is not saved, and the reason is printed.",
      "This sets the whole repository: an option left out takes its default. --clear removes it.",
      "The manager decides how the tree lands in the home directory. auto uses chezmoi for a chezmoi source and stow only for package directories with no dotfiles beside them; any other tree is copied. copy copies the tree as it is, stow links each top-level directory as a stow package, and chezmoi runs chezmoi apply with the tree as its source.",
    ],
    options: [
      { flag: "--ref <r>", text: "the branch to clone. Default: the remote's default branch" },
      {
        flag: "--subdirectory <d>",
        text: "apply only this directory of the repository, e.g. dots. Default: the root",
      },
      { flag: "--manager <m>", text: "auto, copy, stow or chezmoi. Default: auto" },
      { flag: "--no-bootstrap", text: "do not run ./install.sh when the tree has one" },
      { flag: "--clear", text: "remove the repository" },
    ],
    examples: [
      {
        command:
          "mend dotfiles repo git@github.com:you/dots.git --subdirectory dots --manager copy",
        text: "",
      },
      { command: "mend dotfiles repo --clear", text: "" },
    ],
    see: ["dotfiles", "dotfiles sync"],
  },
  {
    name: "dotfiles sync",
    section: "project setup",
    summary: "capture config files from this machine into your store",
    synopsis: ["[--all | paths...]"],
    description: [
      "Copies the named files from your home directory into your store on the server. Paths are relative to your home directory; a path outside it is refused before anything is read. --all takes the known shell, git, and editor files. Setups that rely on ZDOTDIR do not transfer.",
    ],
    options: [{ flag: "--all", text: "every known config file" }],
    see: ["dotfiles", "dotfiles repo"],
  },
  {
    name: "secrets",
    section: "project setup",
    summary: "your secret files: written into every session you launch",
    synopsis: ["[list]"],
    description: [
      "A secret file is a file you keep in Mend, encrypted at rest, with its path under the home directory of the workspace: ~/.aws/credentials, a kubeconfig, an .npmrc token file. Every session you own receives your secret files before its agent starts, in every project. They are yours alone: no one else's sessions receive them, and the content never comes back out of the server. The web app's settings page shows the same list.",
      "A secret file is never captured. It is written into the workspace's own home directory, which no capture, change, checkpoint or transcript harvest covers, and a path under a directory sessions do capture, such as .claude or .codex, is refused.",
      "This lists your secret files: the path each takes in the workspace, its size, and when it last changed.",
    ],
    examples: [{ command: "mend secrets", text: "" }],
    see: ["secrets add", "secrets rm", "env load"],
  },
  {
    name: "secrets add",
    section: "project setup",
    summary: "keep a file as a secret file, or replace one",
    synopsis: ["<path> [--from <file>]"],
    description: [
      "Reads the content from <file>, or from stdin without --from, and keeps it at <path> under the workspace home. A path on this machine under your home, such as ~/.aws/credentials, names the same place in the workspace. A file already kept at that path is replaced. Sessions launched from then on receive it; a running session keeps what it has.",
      "A file is at most 256 KB, and you may keep up to 64. Binary files are fine.",
    ],
    options: [{ flag: "--from <file>", text: "read the content from this file instead of stdin" }],
    examples: [
      { command: "mend secrets add ~/.aws/credentials --from ~/.aws/credentials", text: "" },
      { command: "mend secrets add .kube/config --from ~/.kube/config", text: "" },
      { command: "mend secrets add .npmrc < ~/.npmrc", text: "" },
    ],
    see: ["secrets", "secrets rm"],
  },
  {
    name: "secrets rm",
    section: "project setup",
    summary: "remove a secret file",
    synopsis: ["<path>"],
    description: [
      "Removes the file kept at <path>. Sessions launched from then on do not receive it; a running session keeps what it has.",
    ],
    examples: [{ command: "mend secrets rm .npmrc", text: "" }],
    see: ["secrets"],
  },
  {
    name: "git-author",
    section: "project setup",
    summary: "the name and email your workspaces commit as",
    synopsis: ["[<name> <email>]", "--clear"],
    description: [
      "Commits the agent makes in your workspaces name this author. Until you set one, it is the name and email you registered with. Without arguments, prints it and where it comes from.",
      "Each workspace receives it as system git config before the agent starts, so a user section in your dotfiles' .gitconfig or in a repository's own config still decides. Sessions launched after a change commit as the new author.",
    ],
    options: [{ flag: "--clear", text: "go back to your account's name and email" }],
    examples: [
      { command: 'mend git-author "Anna Example" anna@example.com', text: "" },
      { command: "mend git-author --clear", text: "" },
    ],
    see: ["dotfiles", "keys mode"],
  },
  {
    name: "keys init",
    section: "project setup",
    summary: "create your Mend key (ed25519) on the server",
    synopsis: [],
    description: [
      "One key per user, held on the server, never copied anywhere. Add the public key to your git account's SSH keys and every repository you can reach works, from detached sessions and the phone too. For one repository only, add it as that repository's deploy key instead.",
    ],
    see: ["keys show", "keys mode", "adopt"],
  },
  {
    name: "keys show",
    section: "project setup",
    summary: "print your Mend public key",
    synopsis: [],
    description: [
      "The key to add to your git account's SSH keys, or as a deploy key on one repository.",
    ],
    see: ["keys init"],
  },
  {
    name: "keys mode",
    section: "project setup",
    summary: "how your remotes are reached: mend-key or bridge",
    synopsis: ["[mend-key|bridge]"],
    description: [
      "mend-key (the default) signs with your Mend key on the server and works whenever the server is up. bridge signs with this machine's ssh-agent, so a hardware key never leaves your desk, but only while a mend command is running here. New projects adopt with this mode; a project's setup page can override it. Without a value, prints the current mode.",
    ],
    see: ["keys init", "keys share"],
  },
  {
    name: "keys share",
    section: "project setup",
    summary: "relay this machine's ssh-agent to the server",
    synopsis: [],
    description: [
      "Bridge mode for projects adopted with --auth bridge: the server's git operations sign with the keys in this machine's ssh-agent, so hardware keys never leave here. Runs until Ctrl-C.",
      "When your mode is bridge (mend keys mode), every attaching mend command and the dashboard do this on their own for as long as they run, so this command is for a machine that is not running one. The server takes one signer at a time; a newer share replaces the older one.",
    ],
    see: ["keys mode", "adopt"],
  },

  // ── organization ───────────────────────────────────────────────────────
  {
    name: "members",
    section: "organization",
    summary: "who belongs to your organization, and their roles",
    synopsis: [],
    description: [
      "Prints the organization's name and one row per member: name, email, role and the day they joined. The row marked with an arrow is you. Owners change roles and remove members in Settings on the web.",
    ],
    see: ["invite"],
  },
  {
    name: "invite",
    section: "organization",
    summary: "print a one-time link that adds someone to your organization",
    synopsis: ["[--role member|owner] [--email <address>] [--days <n>]"],
    description: [
      "Owners only. Prints a link that works once. Whoever opens it creates an account and joins with the role you pick. Mend sends no email: you share the link yourself. Bind it to an email when it must not be forwarded.",
    ],
    options: [
      { flag: "--role <role>", text: "member or owner. Default: member" },
      { flag: "--email <address>", text: "only an account with this email may accept it" },
      { flag: "--days <n>", text: "days until the link expires. Default: 7, at most 30" },
    ],
    examples: [{ command: "mend invite --email sam@acme.dev", text: "a member link for Sam only" }],
    see: ["members"],
  },
  {
    name: "folder list",
    section: "organization",
    summary: "list your organization's folders",
    synopsis: [],
    description: [
      "Folders are directories Mend keeps for the organization. A project mounts the ones it selects at /workspace/home/<name>, read-only unless chosen otherwise, for its next sessions.",
    ],
    see: ["folder create", "folder push"],
  },
  {
    name: "folder create",
    section: "organization",
    summary: "create an organization folder",
    synopsis: ["<name>"],
    description: [
      "Owners only. Names use lowercase letters, digits, dots, underscores and dashes. A project picks the folder in its setup on the web.",
    ],
    see: ["folder push", "folder list"],
  },
  {
    name: "folder push",
    section: "organization",
    summary: "upload a local directory into a folder",
    synopsis: ["<name> <dir> [--replace]"],
    description: [
      "Owners only. Sends every file under <dir>, keeping paths relative to it. .git and node_modules directories, symlinks and files over 1 MiB are skipped and counted. Without --replace the files are added beside what the folder holds.",
    ],
    options: [{ flag: "--replace", text: "empty the folder first, so it holds exactly <dir>" }],
    examples: [{ command: "mend folder push fixtures ./test/fixtures --replace", text: "" }],
    see: ["folder create", "folder rm"],
  },
  {
    name: "folder rm",
    section: "organization",
    summary: "remove an organization folder",
    synopsis: ["<name>"],
    description: [
      "Owners only. A folder a project still mounts is refused: deselect it in that project's setup first.",
    ],
    see: ["folder list"],
  },
  {
    name: "session share",
    section: "organization",
    summary: "let everyone who can see a session steer it, or stop",
    synopsis: ["<session> on|off [--yes]"],
    description: [
      "The session's owner turns shared control on or off; an organization owner may turn it off. While it is on, anyone who can see the project sends turns, answers approvals and interrupts. They can read the terminal; only the owner types in it, opens a shell or starts a Service. Every act is recorded with who did it. A prefix of the session id is enough.",
      "Turning it on asks first, in every worktree, in the words true to it; --yes answers for a script, and is required without a terminal. Turning it off asks nothing.",
      `In a worktree that runs each person as themselves, it asks: ${sharedControlConfirm(true).body}`,
      `Otherwise it asks: ${sharedControlConfirm(false).body}`,
    ],
    options: [
      {
        flag: "--yes",
        text: "turn it on without asking; required without a terminal",
      },
    ],
    examples: [{ command: "mend session share 3f2a on", text: "" }],
    see: ["sessions"],
  },

  // ── this machine ───────────────────────────────────────────────────────
  {
    name: "operator org list",
    section: "this machine",
    summary: "list organizations with their member and owner counts",
    synopsis: [],
    description: [
      "Operator only. One line per organization. An organization with no owner says so: bring one in with mend operator org invite-owner or mend operator grant-owner. The operator administers the instance and reads no organization content.",
    ],
    see: ["operator org invite-owner", "operator grant-owner"],
  },
  {
    name: "operator exposure",
    section: "this machine",
    summary: "how this instance is exposed, as declared and as observed",
    synopsis: [],
    description: [
      "Operator only. States MEND_EXPOSURE as declared (loopback, private or public) and one line per item of the public exposure gate, with how it was established: observed (this server read it), carried (this build contains it, and the server cannot see it in effect), declared (you stated it and the server cannot check it), or open. MEND_EXPOSURE=public refuses to start while an item that blocks a start is open: every item the server can observe, and workspace-ssh until you declare it. Items it cannot observe say what would verify them; once you have verified core-private, edge-tls, workspace-ssh (SSH published apart from the web port) or (while it is enabled) t3code-gateway from outside, name it in MEND_EXPOSURE_DECLARED, or with mend server setup --declare. The report is what was observed; it is not a statement that the instance is fit to expose.",
    ],
    see: ["operator gate", "doctor"],
  },
  {
    name: "operator gate",
    section: "this machine",
    summary: "what MEND_TENANCY=multi still needs on this instance",
    synopsis: [],
    description: [
      "Operator only. One line per item of the multi mode gate: what this instance shows, and what would satisfy an open item. Multi tenancy refuses to start while any item is open.",
    ],
    see: ["operator org list"],
  },
  {
    name: "operator org create",
    section: "this machine",
    summary: "create an organization (multi tenancy only)",
    synopsis: ["<name>"],
    description: [
      "Operator only, and only when MEND_TENANCY=multi. The organization starts empty: invite its first owner next.",
    ],
    see: ["operator org invite-owner"],
  },
  {
    name: "operator org rename",
    section: "this machine",
    summary: "rename an organization",
    synopsis: ["<org> <name>"],
    description: ["Operator only. Recorded in the organization's audit log."],
    see: ["operator org list"],
  },
  {
    name: "operator org invite-owner",
    section: "this machine",
    summary: "print a one-time owner invitation for an organization",
    synopsis: ["<org> [--email <address>]"],
    description: [
      "Operator only. Prints a link that works once and makes whoever opens it an owner of the organization. Recorded in its audit log.",
    ],
    options: [{ flag: "--email <address>", text: "only an account with this email may accept it" }],
    see: ["operator grant-owner"],
  },
  {
    name: "operator grant-owner",
    section: "this machine",
    summary: "make an existing member an owner",
    synopsis: ["<org> <email>"],
    description: [
      "Operator only. For an organization whose owners are gone or locked out. The account must already be a member. Recorded in the organization's audit log.",
    ],
    see: ["operator org invite-owner"],
  },
  {
    name: "operator reset-link",
    section: "this machine",
    summary: "print a one-time password reset link for an account",
    synopsis: ["<email>"],
    description: [
      "Operator only. Mend sends no email, so you hand the link over. It works once, expires after a day, and setting a password with it signs the account out everywhere. Owners reset their members' passwords from Settings.",
    ],
    see: ["operator grant-owner"],
  },
  {
    name: "server",
    section: "this machine",
    summary: "install and manage this machine's Mend server",
    synopsis: ["<command>"],
    description: [
      "Server commands manage the local Docker Compose installation. They do not sign this CLI in or change Docker's global context.",
    ],
    see: [
      "server setup",
      "server status",
      "server start",
      "server stop",
      "server restart",
      "server logs",
      "server upgrade",
    ],
  },
  {
    name: "server setup",
    section: "this machine",
    summary: "install or repair the local Mend server",
    synopsis: [
      "[--context <name>] [--version <version|latest>] [--bind <ip>] [--ssh-bind <ip>] [--url <origin>] [--origin <origin>...] [--port <n>] [--ssh-port <n>] [--edge <host> | --no-edge] [--exposure <loopback|private|public>] [--tenancy <single|multi>] [--declare <item>...] [--t3-gateway [--t3-gateway-port <n>] | --no-t3-gateway] [--npm-mirror | --no-npm-mirror] [--npm-mirror-max-size <size>] [--docker-mirror | --no-docker-mirror] [--docker-mirror-max-size <size>] [--docker-hub-username <name> --docker-hub-token-stdin --docker-hub-public-only | --no-docker-hub-login] [--docker-socket <path>] [--assets-dir <dir>] [--offline]",
    ],
    description: [
      "Checks a local Unix-socket Docker context and the Compose plugin, downloads the compose and Postgres initialization assets for one Mend release, preserves existing data and secrets, and starts the server. Re-running repairs the same pinned version. A changed --version is refused; use mend server upgrade. Updating this CLI never updates an existing server pin.",
      "The default listens only on localhost at http://localhost:3105. Non-local access requires both --bind and --url. Every extra browser origin must be named with --origin; setup never guesses from the request Host header or network interfaces.",
      "--edge <host> runs a TLS edge in front of Mend: Caddy on ports 80 and 443 of every interface, which obtains and renews a certificate for the host and proxies to Mend's web tier. Mend's own port stays on loopback and the browser origin is https://<host>. The edge's compose overlay and Caddyfile are written into the generation beside compose.yaml, so start, restart and upgrade run them every time. --no-edge takes it away again, and the edge's container with it. A fresh install cannot start with the edge: until the first account exists, registration is open to whoever reaches the origin first, so set up on localhost, create the account, then add the edge.",
      "--t3-gateway turns on the t3code gateway (docs/adr/0012): t3code's desktop, mobile and web clients add it as an environment, pair with a code from mend pair, and see this Mend's projects and sessions. It runs in the Mend container, confined to a root and a uid of its own, on a listener of its own published on 127.0.0.1 only (port 3120, or --t3-gateway-port): reaching it from another machine is an exposure you put in front of it and declare. Setup refuses it on a Mend image that has no gateway, and says whether it answered. It is kept across reruns and upgrades; --no-t3-gateway turns it off, and its state stays in its own volume, mend-t3-gateway. Off, nothing of it runs.",
      "--exposure declares how the instance is reached, and --tenancy whether one organization or many use it. Both are written into the generation and kept across reruns and upgrades. public needs the edge and an existing first account. With multi, or with public, the multi mode gate's settings follow: MEND_SOURCE_POLICY=tenant and MEND_CAPTURE_REQUIRE_SIZES=true, and public sets MEND_URL_BEARERS=refuse. The server still decides whether it starts, and mend server status shows what it reports.",
      "Two mirrors run beside Mend unless turned off: an npm mirror (nginx caching npmjs.org, capped at 10g by default, least recently used out) and a Docker mirror (a pull-through cache of Docker Hub, capped at 20g by default: over the cap its cache is cleared). Both leave 5g free on their disk: below that, nginx evicts and the Docker mirror pauses, and sessions pull from Docker Hub directly. Neither publishes a host port. Sessions install npm packages and pull Docker Hub images through them; a project's own npm settings win, and a mirror that is down sends sessions upstream instead. Both are kept across reruns and upgrades, and an upgrade adds them to an install from before them. The Docker mirror pulls anonymously unless given a Docker Hub login: --docker-hub-username with the access token piped on standard input, kept in server.env only. The mirror has no login of its own, so every session that reaches it can pull whatever that token can read: setup takes a login only with --docker-hub-public-only, your statement that the token's access permission is Public Repo Read-only. Mend cannot check a token's scope.",
      "Docker Desktop on Linux and macOS, and OrbStack on macOS, expose client-side proxy sockets. Containers use the daemon-side /var/run/docker.sock. --docker-socket overrides detection and is retained on reruns.",
      "Setup holds an exclusive process lock through startup and health checks. A busy lock reports its owner and manual recovery steps. Never remove a live lock. Private configuration uses immutable generations and an atomic active pointer; failed attempts retain credentials and never delete Docker volumes.",
    ],
    options: [
      {
        flag: "--context <name>",
        text: "local Docker context to persist; the global context is unchanged",
      },
      {
        flag: "--version <v>",
        text: "exact Mend server version, or latest; omitted keeps the current pin",
      },
      { flag: "--bind <ip>", text: "published listen address. Default: 127.0.0.1" },
      {
        flag: "--ssh-bind <ip>",
        text: "where workspace SSH is published, when not on --bind; with --edge, Remote-SSH from another machine needs it. Kept across reruns; the --bind address takes it away",
      },
      { flag: "--url <origin>", text: "advertised browser URL, required with a non-loopback bind" },
      {
        flag: "--origin <origin>",
        text: "additional exact browser origin; repeat for more than one",
      },
      { flag: "--port <n>", text: "external web port. Default: 3105" },
      {
        flag: "--ssh-port <n>",
        text: "external workspace SSH port. Default: 2222; must differ from --port",
      },
      {
        flag: "--edge <host>",
        text: "run the Caddy TLS edge for this DNS name on 80 and 443; the origin becomes https://<host>, --bind stays on loopback, and the first account must already exist",
      },
      { flag: "--no-edge", text: "take a saved edge away; the origin returns to http://localhost" },
      {
        flag: "--t3-gateway",
        text: "run the t3code gateway, published on 127.0.0.1:3120 only; kept across reruns and upgrades",
      },
      {
        flag: "--t3-gateway-port <n>",
        text: "the gateway's port on 127.0.0.1; implies --t3-gateway",
      },
      { flag: "--no-t3-gateway", text: "turn the t3code gateway off; its state stays" },
      {
        flag: "--exposure <v>",
        text: "declare loopback, private or public; kept across reruns and upgrades. public needs --edge and an existing first account",
      },
      {
        flag: "--tenancy <v>",
        text: "declare single or multi; kept across reruns and upgrades. multi also sets the multi mode gate's variables",
      },
      {
        flag: "--declare <item>",
        text: "state a gate item you verified from outside: core-private, edge-tls or workspace-ssh; repeat for more, none clears. Kept across reruns. public with --ssh-bind beyond loopback needs workspace-ssh",
      },
      {
        flag: "--npm-mirror, --no-npm-mirror",
        text: "run or stop the npm mirror; kept across reruns and upgrades. Default: on",
      },
      {
        flag: "--npm-mirror-max-size <size>",
        text: "the npm mirror's disk cap, such as 20g or 1536m, at least 1g. Default: 10g",
      },
      {
        flag: "--docker-mirror, --no-docker-mirror",
        text: "run or stop the Docker Hub mirror; kept across reruns and upgrades. Default: on",
      },
      {
        flag: "--docker-mirror-max-size <size>",
        text: "the Docker mirror's cap, such as 40g; over it the cache is cleared and fills again. Default: 20g",
      },
      {
        flag: "--docker-hub-username <name>",
        text: "the Docker mirror pulls as this Docker Hub account; needs --docker-hub-token-stdin",
      },
      {
        flag: "--docker-hub-token-stdin",
        text: "read that account's access token from standard input; kept in server.env, never in argv or a session",
      },
      {
        flag: "--docker-hub-public-only",
        text: "required with a login: you state the token is scoped Public Repo Read-only, since every session can pull what it can read",
      },
      { flag: "--no-docker-hub-login", text: "the Docker mirror pulls anonymously again" },
      {
        flag: "--assets-dir <dir>",
        text: "copy compose.v2.yaml and postgres-init.sh from a release directory; fresh setup requires --version",
      },
      {
        flag: "--offline",
        text: "use retained or supplied assets and preloaded images only; no GitHub requests or release-image pulls; exact image label and health version required",
      },
      { flag: "--docker-socket <path>", text: "daemon-side socket mount override for diagnostics" },
    ],
    examples: [
      { command: "mend server setup", text: "localhost, using the current local Docker context" },
      {
        command:
          "mend server setup --context orbstack --bind 0.0.0.0 --url http://100.70.80.90:3105",
        text: "explicit private-network exposure (a tailnet, a LAN, a VPN)",
      },
      {
        command: "mend server setup --version 0.25.0 --assets-dir ./release-assets --offline",
        text: "install from local release assets and preloaded images",
      },
      {
        command:
          "mend server setup --edge mend.example.com --ssh-bind 0.0.0.0 --exposure public --declare workspace-ssh",
        text: "the TLS edge for the browser and the API, and workspace SSH for Remote-SSH from other machines",
      },
      {
        command: "mend server setup --edge mend.example.com",
        text: "a TLS edge for mend.example.com; its DNS points at this machine and 80 and 443 reach it",
      },
      {
        command: "mend server setup --exposure public --tenancy multi",
        text: "on an install with an edge and a first account: declare public, many organizations",
      },
      {
        command:
          'printf %s "$DOCKER_HUB_TOKEN" | mend server setup --docker-hub-username mendbot --docker-hub-token-stdin --docker-hub-public-only',
        text: "the Docker mirror pulls from Docker Hub as mendbot, with a Public Repo Read-only token",
      },
    ],
    see: ["server", "server status", "login", "doctor", "operator exposure"],
  },
  {
    name: "server status",
    section: "this machine",
    summary: "show the pin, generation, containers, edge, mirrors and posture",
    synopsis: [""],
    description: [
      "Reads the existing installation without changing its files. A running Mend must answer health with the exact pinned version. A stopped server makes no health claim. Never installs a server implicitly.",
      "Each mirror the install runs follows, as observed: whether its container runs, what its cache holds, and its traffic. For the npm mirror, the tarball requests in its log for the last 24 hours and how many the cache served; for the Docker mirror, layer and manifest requests since it started and how many the cache served.",
      "Then the posture, declared beside observed. Declared is what this install's configuration says: the edge host, MEND_EXPOSURE and MEND_TENANCY, a default named as one. Observed is what was seen: whether the edge's container runs and whether Caddy's data holds a certificate for the host, and what the running server reports in its health, the exposure it runs with and how many public exposure gate items are open, the tenancy and which multi mode gate items are open. When this machine is signed in to the install as the operator, every item of both gates follows with its detail, as mend operator gate and mend operator exposure print them. None of it is a verdict: the report says what was declared and what was observed.",
    ],
    see: ["server logs", "server start", "operator gate", "operator exposure"],
  },
  {
    name: "server start",
    section: "this machine",
    summary: "start the selected server generation",
    synopsis: ["[--offline]"],
    description: [
      "Reuses the saved context, generation, credentials and exact pin. Uses preloaded release images, with no release-image pulls or asset downloads, even without --offline. Exact image label and health version are required.",
    ],
    options: [{ flag: "--offline", text: "use local release images and assets" }],
    see: ["server status", "server upgrade"],
  },
  {
    name: "server stop",
    section: "this machine",
    summary: "stop the server's containers without deleting data",
    synopsis: [""],
    description: [
      "Stops only the installation's Compose services, the edge among them when one is set. Connections are interrupted. Workspace containers and volumes remain, but active work may lose connectivity and need reconnection. No volume deletion or Docker prune is performed.",
    ],
    see: ["server start", "server status"],
  },
  {
    name: "server restart",
    section: "this machine",
    summary: "restart Mend using the same generation and pin",
    synopsis: ["[--offline]"],
    description: [
      "Checks preloaded images before stopping Mend, then starts the saved generation and verifies exact-version health. Postgres and Garage stay running. Connections are interrupted; workspace containers and data remain, but active work may need reconnection.",
    ],
    options: [{ flag: "--offline", text: "use local release images and assets" }],
    see: ["server status", "server logs"],
  },
  {
    name: "server logs",
    section: "this machine",
    summary: "print a bounded tail of the installation's container logs",
    synopsis: ["[--tail <n>]"],
    description: [
      "Reads logs without changing the configuration or data. No follow mode; output capture is also byte-bounded. Treat container logs as private before sharing them.",
    ],
    options: [{ flag: "--tail <n>", text: "lines per service, 1..1000. Default: 100" }],
    see: ["server status"],
  },
  {
    name: "server upgrade",
    section: "this machine",
    summary: "upgrade to an explicit version with a database backup",
    synopsis: [
      "--version <target|latest> [--assets-dir <dir>] [--offline] [--from-preview] [--keep-backups <n>]",
    ],
    description: [
      "Preflights release assets and the canonical image's version label before interrupting Mend. Downgrades are refused. latest is resolved only when explicitly requested; a same-version request does nothing.",
      "The installed configuration stays: the bind, the origin, the ports, the edge host and the declared exposure and tenancy are carried into the new generation, which renders the same overlays beside the new compose.yaml. An upgrade never drops the edge or the posture; mend server setup is where they change.",
      "Stops app writers, starts official Postgres if needed, and streams pg_dumpall into a private database backup before selecting and starting the target. Connections are interrupted. Workspace containers and data are retained, but active work can lose connectivity and need reconnection. Stop any external database writers before upgrading.",
      "Preflight or backup failure retains the old pin and attempts to recover the old app if it was running. Once target startup may have begun, Mend never automatically downgrades or restores the database. The target pin, old generation and backup remain. Inspect logs, fix the target, then use mend server start. Recovery records are under the installation's backups/upgrade-UUID directory.",
      "After the target answers health, its recovery record is marked completed and older completed backups are removed, keeping the newest two (this one included) in the order Mend wrote them; each removal is printed with the space it freed. A failed upgrade removes nothing. A backup this release recorded as pending, or whose dump is incomplete, is always kept. Each dump holds the whole database, so it can run to gigabytes.",
      'Backups written by releases before 0.36 carry no outcome: the first upgrade on 0.36 or later treats each one whose dump is whole as completed and keeps only the newest N, so copy any you want to keep out of backups/ first. Their removals are marked "from before 0.36, no recorded outcome".',
    ],
    options: [
      {
        flag: "--version <target|latest>",
        text: "required exact target version, or explicit latest",
      },
      {
        flag: "--assets-dir <dir>",
        text: "copy target compose.v2.yaml and postgres-init.sh from local release assets",
      },
      {
        flag: "--offline",
        text: "no GitHub requests or release-image pulls; target assets and exact-version images must be local",
      },
      {
        flag: "--from-preview",
        text: "once, from a preview numbered X.Y.Z-preview.K to a next build X.Y.Z-next.N; refused unless the target carries every migration the server applied",
      },
      {
        flag: "--keep-backups <n>",
        text: "completed upgrade backups to keep after a healthy upgrade, this one included; 0 keeps all. Default: 2",
      },
    ],
    examples: [
      {
        command: "mend server upgrade --version 0.24.0 --assets-dir ./release-0.24.0 --offline",
        text: "controlled offline upgrade",
      },
    ],
    see: ["server logs", "server status", "server start"],
  },
  {
    name: "ssh",
    section: "this machine",
    summary: "workspace SSH status: gateway, registered keys, ssh config",
    synopsis: ["[status]"],
    description: ["Whether this machine can ssh into workspaces, and what is missing if not."],
    see: ["ssh setup", "ssh keys"],
  },
  {
    name: "ssh setup",
    section: "this machine",
    summary: "make this machine ready to ssh into workspaces, once",
    synopsis: ["[--key <path>] [--host <hostname>]"],
    description: [
      "Registers this client's public key and writes a server-specific managed Host block to ~/.ssh/config. The hostname defaults to the configured Mend URL; the gateway supplies the SSH port.",
    ],
    options: [
      { flag: "--key <path>", text: "the public key to register" },
      { flag: "--host <hostname>", text: "override only the SSH hostname" },
    ],
    see: ["ssh", "ssh keys", "shell"],
  },
  {
    name: "ssh keys",
    section: "this machine",
    summary: "your registered workspace ssh keys, from every machine",
    synopsis: ["[--json]"],
    description: [
      "Every key your account registered with the workspace SSH gateway: fingerprint, name, algorithm and the day it was registered. The key this machine would offer is marked. The platform does not record when a key was last used.",
    ],
    options: [{ flag: "--json", text: "the keys as JSON, with thisMachine on each" }],
    see: ["ssh keys remove", "ssh setup"],
  },
  {
    name: "ssh keys remove",
    section: "this machine",
    summary: "stop the workspace ssh gateway accepting one of your keys",
    synopsis: ["<fingerprint>"],
    description: [
      "Removes one of your keys by fingerprint; the SHA256: prefix is optional. The gateway looks a key up on every new connection, so the next connection offering it is refused. A connection already open stays open until it ends.",
      "Only your own keys are listed and removed. The key file and the ~/.ssh/config block on the machine that registered it stay; mend ssh setup there registers it again. Removing a member from the organization removes all of theirs, and Mend keeps retrying any the platform refused.",
    ],
    examples: [
      {
        command: "mend ssh keys remove SHA256:Vn6v0P2dHq1n2a5aGQ6L7rKk8sWm0u3x1zYbTq9cE4o",
        text: "revoke a lost laptop's key",
      },
    ],
    see: ["ssh keys"],
  },
  {
    name: "accounts",
    section: "this machine",
    summary: "your connected accounts on the platform",
    synopsis: [],
    description: [
      "claude, codex, and github: connected, invalid, or archived, and when each was last used.",
    ],
    see: ["connect"],
  },
  {
    name: "logout",
    section: "this machine",
    summary: "revoke this terminal's device token and forget it",
    synopsis: [],
    description: ["Other terminals and devices keep their own tokens."],
    see: ["login"],
  },
  {
    name: "uninstall",
    section: "this machine",
    summary: "remove the server, this machine's Mend files, or both",
    synopsis: ["[--all | --server | --home] [--yes]"],
    description: [
      "Asks which scope to remove when none is given, prints exactly what will go, and requires the word delete before the server is touched. The server scope removes the local Compose installation: its containers, every volume it owns (repositories, worktrees, the database), its release image, and the private configuration with its generations and backups. The home scope asks the server to remove the workspace SSH key this machine registered and to revoke this terminal's device token, then removes cli.json, the workspace SSH key file, and the managed block in ~/.ssh/config. The key is found by its public half; a key the server refuses to remove, or one this machine cannot read, makes the uninstall exit 1 naming what may still be registered. The account's other keys and devices stay.",
      "Nothing else under the configuration directory is touched; a host-run store or keys root is listed and left in place. Workspace containers carry no label Mend can filter on, so they are named with the command that removes them, never removed.",
    ],
    options: [
      { flag: "--all", text: "the server and this machine's Mend files" },
      { flag: "--server", text: "only the local server installation" },
      { flag: "--home", text: "only this machine's sign-in, ssh key and config block" },
      { flag: "--yes", text: "skip the confirmation; required without a terminal" },
    ],
    examples: [
      { command: "mend uninstall", text: "choose a scope, then confirm" },
      {
        command: "mend uninstall --home --yes",
        text: "forget this machine's sign-in without asking",
      },
    ],
    see: ["server stop", "logout"],
  },
  {
    name: "completions",
    section: "this machine",
    summary: "print the TAB-completion hook",
    synopsis: ["zsh|bash"],
    description: [
      "Commands complete, and live session ids complete under TAB by asking the server.",
    ],
    examples: [{ command: 'mend completions zsh > "$fpath[1]/_mend"', text: "" }],
  },
  {
    name: "version",
    section: "this machine",
    summary: "this CLI's version, and the server's when it answers",
    synopsis: [],
    description: [
      "Two lines: the version of this CLI, then the server's from its health route. A server that does not answer within two seconds prints as unreachable. --version and -v do the same.",
    ],
    see: ["doctor"],
  },
  {
    name: "help",
    section: "this machine",
    summary: "this index, or one command's page",
    synopsis: ["[command...]"],
    description: [
      "mend help alone lists every command by section. mend help <command> prints that command's page: usage, description, options, examples. mend <command> --help is the same page.",
    ],
    see: ["man"],
  },
  {
    name: "man",
    section: "this machine",
    summary: "one command's page, or the whole manual, in man",
    synopsis: ["[command...]"],
    description: [
      "Renders the same pages as roff and opens them in man. Without man on the PATH, the text page prints instead. The npm package also installs mend(1) and mend-<command>(1), so man mend works after a global install.",
    ],
    see: ["help"],
  },
  {
    name: "qr",
    section: "this machine",
    summary: "render a QR code for the installer",
    synopsis: ["<text>"],
    description: ["The installer renders its pairing QR through this."],
    hidden: true,
  },
];

// ── lookup ────────────────────────────────────────────────────────────────

const firstWord = (doc: CommandDoc) => doc.name.split(" ")[0] ?? doc.name;

/**
 * The longest catalog entry the leading words name. `help service run` finds
 * "service run"; `help service` finds the group (every "service …" page);
 * `help claude` finds the codex page through its alias.
 */
export const findCommand = (words: ReadonlyArray<string>): CommandDoc | null => {
  const [first, ...rest] = words;
  if (first === undefined) return null;
  const candidates = COMMANDS.filter(
    (doc) => firstWord(doc) === first || doc.aliases?.includes(first),
  );
  let best: CommandDoc | null = null;
  for (const doc of candidates) {
    const tail = doc.name.split(" ").slice(1);
    if (tail.every((word, index) => rest[index] === word)) {
      if (best === null || doc.name.length > best.name.length) best = doc;
    }
  }
  return best;
};

/** Every page whose name starts with the word: the "service …" family. */
export const commandGroup = (first: string): ReadonlyArray<CommandDoc> =>
  COMMANDS.filter((doc) => !doc.hidden && firstWord(doc) === first && doc.name.includes(" "));

/** `usage: mend <name> <synopsis>` for an error line; one line per shape. */
export const usageOf = (name: string): string => {
  const doc = findCommand(name.split(" "));
  if (doc === null) return `usage: mend ${name}`;
  const shapes = doc.synopsis.length === 0 ? [""] : doc.synopsis;
  return shapes
    .map(
      (shape, index) =>
        `${index === 0 ? "usage: " : "       "}mend ${doc.name}${shape === "" ? "" : ` ${shape}`}`,
    )
    .join("\n");
};

// ── text rendering ────────────────────────────────────────────────────────

/**
 * Wrap at `width`, keeping `indent` spaces on every line; `hang` adds that
 * many more on continuation lines, so a usage line reads as one shape.
 */
export const wrap = (text: string, width: number, indent = 0, hang = 0): ReadonlyArray<string> => {
  const lines: Array<string> = [];
  let line = "";
  const room = () => Math.max(16, width - indent - (lines.length === 0 ? 0 : hang));
  for (const word of text.split(/\s+/).filter((w) => w !== "")) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= room()) line += ` ${word}`;
    else {
      lines.push(" ".repeat(indent + (lines.length === 0 ? 0 : hang)) + line);
      line = word;
    }
  }
  if (line !== "") lines.push(" ".repeat(indent + (lines.length === 0 ? 0 : hang)) + line);
  return lines;
};

/** Two columns: a label, then text wrapped beside it (or under it when the label is long). */
const twoColumns = (
  rows: ReadonlyArray<readonly [string, string]>,
  width: number,
  indent = 2,
  gap = 2,
): ReadonlyArray<string> => {
  const longest = Math.max(0, ...rows.map(([label]) => label.length));
  const column = Math.min(longest, 28) + gap;
  const out: Array<string> = [];
  for (const [label, text] of rows) {
    const body = wrap(text, width, indent + column);
    if (label.length + gap > column || body.length === 0) {
      out.push(" ".repeat(indent) + label);
      out.push(...body);
      continue;
    }
    const [first, ...more] = body;
    out.push(" ".repeat(indent) + label.padEnd(column) + (first ?? "").trimStart());
    out.push(...more);
  }
  return out;
};

const ENVIRONMENT: ReadonlyArray<readonly [string, string]> = [
  ["MEND_URL", "the server. Default http://localhost:3105"],
  ["MEND_TOKEN", "a token in place of the saved login"],
  [
    "MEND_DETACH_KEY",
    "the detach chord; default Ctrl+]. none when an outer multiplexer owns detaching",
  ],
];

const FILES: ReadonlyArray<readonly [string, string]> = [
  ["~/.config/mend/cli.json", "url, token, and device id from mend login"],
  ["~/.config/mend/keys/", "the deploy key from mend keys init"],
];

export const terminalWidth = (): number => Math.min(process.stdout.columns ?? 80, 100);

/** `mend help`: every command by section, one line each. */
export const renderIndex = (width = terminalWidth()): string => {
  const out: Array<string> = ["mend · the agent workbench", ""];
  const visible = COMMANDS.filter((doc) => !doc.hidden);
  const longest = Math.max(...visible.map((doc) => doc.name.length));
  const column = longest + 2;
  for (const section of SECTIONS) {
    out.push(section);
    for (const doc of visible.filter((d) => d.section === section)) {
      const body = wrap(doc.summary, width, 2 + column);
      out.push(`  ${doc.name.padEnd(column)}${(body[0] ?? "").trimStart()}`);
      out.push(...body.slice(1));
    }
    out.push("");
  }
  out.push(
    ...wrap(
      "mend help <command> for usage, options, and examples; mend <command> --help is the same page. man mend after a global install, or mend man <command>.",
      width,
    ),
  );
  out.push("");
  out.push("environment");
  out.push(...twoColumns(ENVIRONMENT, width));
  out.push("");
  out.push("files");
  out.push(...twoColumns(FILES, width));
  return out.join("\n");
};

const invocations = (doc: CommandDoc): ReadonlyArray<string> => {
  const shapes = doc.synopsis.length === 0 ? [""] : doc.synopsis;
  return shapes.map((shape) => `mend ${doc.name}${shape === "" ? "" : ` ${shape}`}`);
};

/** "also mend claude, mend opencode" for a page that several first words reach. */
const aliasNote = (doc: CommandDoc): string | null =>
  doc.aliases === undefined || doc.aliases.length === 0
    ? null
    : `also ${doc.aliases.map((alias) => `mend ${alias}`).join(", ")}, with the same options`;

/** `mend help <command>`: one page. */
export const renderCommand = (doc: CommandDoc, width = terminalWidth()): string => {
  const out: Array<string> = [`mend ${doc.name} · ${doc.summary}`, "", "usage"];
  for (const line of invocations(doc)) out.push(...wrap(line, width, 2, 4));
  const alias = aliasNote(doc);
  if (alias !== null) out.push(`  ${alias}`);
  out.push("", "description");
  for (const paragraph of doc.description) {
    out.push(...wrap(paragraph, width, 2));
    out.push("");
  }
  if (doc.options !== undefined && doc.options.length > 0) {
    out.push("options");
    out.push(
      ...twoColumns(
        doc.options.map((o) => [o.flag, o.text] as const),
        width,
      ),
    );
    out.push("");
  }
  if (doc.examples !== undefined && doc.examples.length > 0) {
    out.push("examples");
    for (const example of doc.examples) {
      out.push(`  ${example.command}`);
      if (example.text !== "") out.push(...wrap(example.text, width, 6));
    }
    out.push("");
  }
  const group = commandGroup(firstWord(doc)).filter((other) => other !== doc);
  if (!doc.name.includes(" ") && group.length > 0) {
    out.push("subcommands");
    out.push(
      ...twoColumns(
        group.map((g) => [g.name, g.summary] as const),
        width,
      ),
    );
    out.push("");
  }
  if (doc.see !== undefined && doc.see.length > 0) {
    out.push("see also");
    out.push(...wrap(doc.see.map((name) => `mend ${name}`).join(" · "), width, 2));
    out.push("");
  }
  return out.join("\n").trimEnd();
};

/** `mend help service`: the family's pages in one. */
export const renderGroup = (first: string, width = terminalWidth()): string | null => {
  const group = commandGroup(first);
  if (group.length === 0) return null;
  const out: Array<string> = [`mend ${first} · ${group.length} commands`, ""];
  out.push(
    ...twoColumns(
      group.map((g) => [g.name, g.summary] as const),
      width,
    ),
  );
  out.push("", `mend help ${first} <subcommand> for one page`);
  return out.join("\n");
};

// ── roff rendering (man pages) ────────────────────────────────────────────

/** Escape for roff: backslashes, leading control characters, and dashes that must stay ASCII. */
export const roff = (text: string): string => {
  const escaped = text.replace(/\\/g, "\\e").replace(/-/g, "\\-");
  return /^[.']/.test(escaped) ? `\\&${escaped}` : escaped;
};

const manHeader = (title: string, version: string, summary: string): ReadonlyArray<string> => [
  `.TH ${title.toUpperCase()} 1 "" "mend ${roff(version)}" "mend manual"`,
  ".SH NAME",
  `${roff(title)} \\- ${roff(summary)}`,
];

/** mend-<command>(1). */
export const renderManPage = (doc: CommandDoc, version: string): string => {
  const title = `mend-${doc.name.replace(/ /g, "-")}`;
  const out: Array<string> = [...manHeader(title, version, doc.summary), ".SH SYNOPSIS"];
  for (const line of invocations(doc)) out.push(`.B ${roff(line)}`, ".br");
  const alias = aliasNote(doc);
  if (alias !== null) out.push(roff(alias));
  out.push(".SH DESCRIPTION");
  for (const paragraph of doc.description) out.push(".PP", roff(paragraph));
  if (doc.options !== undefined && doc.options.length > 0) {
    out.push(".SH OPTIONS");
    for (const option of doc.options) out.push(".TP", `.B ${roff(option.flag)}`, roff(option.text));
  }
  if (doc.examples !== undefined && doc.examples.length > 0) {
    out.push(".SH EXAMPLES");
    for (const example of doc.examples) {
      out.push(".PP", `.B ${roff(example.command)}`);
      if (example.text !== "") out.push(".br", roff(example.text));
    }
  }
  const see = ["mend(1)", ...(doc.see ?? []).map((name) => `mend-${name.replace(/ /g, "-")}(1)`)];
  out.push(".SH SEE ALSO", roff(see.join(", ")));
  return `${out.join("\n")}\n`;
};

/** mend(1): the index plus every page as a section. */
export const renderManIndex = (version: string): string => {
  const out: Array<string> = [
    ...manHeader("mend", version, "the agent workbench"),
    ".SH SYNOPSIS",
    ".B mend",
    "[\\fIcommand\\fR] [\\fIoptions\\fR]",
    ".SH DESCRIPTION",
    ".PP",
    roff(
      "Mend adopts a repository into a central store, runs your coding agent (codex, claude, opencode, or any command) in a recorded git worktree on the platform, and lets you attach, review, and steer from any terminal or device. Each command has its own page: mend-<command>(1).",
    ),
  ];
  for (const section of SECTIONS) {
    out.push(`.SH ${section.toUpperCase()}`);
    for (const doc of COMMANDS.filter((d) => !d.hidden && d.section === section)) {
      out.push(".TP", `.B mend ${roff(doc.name)}`, roff(doc.summary));
    }
  }
  out.push(".SH ENVIRONMENT");
  for (const [name, text] of ENVIRONMENT) out.push(".TP", `.B ${roff(name)}`, roff(text));
  out.push(".SH FILES");
  for (const [name, text] of FILES) out.push(".TP", `.B ${roff(name)}`, roff(text));
  out.push(".SH SEE ALSO");
  out.push(
    roff(
      COMMANDS.filter((d) => !d.hidden)
        .map((d) => `mend-${d.name.replace(/ /g, "-")}(1)`)
        .join(", "),
    ),
  );
  return `${out.join("\n")}\n`;
};

/** The file name each page installs as. */
export const manFileName = (doc: CommandDoc | null): string =>
  doc === null ? "mend.1" : `mend-${doc.name.replace(/ /g, "-")}.1`;
