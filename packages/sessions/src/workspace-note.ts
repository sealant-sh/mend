/**
 * The workspace note: what rides beside the repo (references, linked repositories, folders) and
 * how to run Services, written into each harness's global memory file in the workspace `$HOME`
 * (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`) at every launch, claim and resume.
 *
 * Those files belong to the user and the agent as much as to Mend: people keep instructions in
 * them, and agents append to them. They live in the durable harness root, so a capture restores
 * them byte for byte, and Mend then rewrites its note in the restored copy. So the note is one
 * bounded block, between a begin and an end marker line, and a launch replaces only that block
 * (review 2026-09-28 (17) #1). Everything before and after it stays byte for byte.
 *
 * Mend used to write an open-ended note: a `<!-- mend:mounts -->` line, then the note through the
 * end of the file, and every launch cut the file at that marker. Anything written below the note
 * was lost at the next resume. A file that still carries that note is migrated only when every
 * line from the marker to the end of the note is exactly what one of Mend's own generators wrote
 * (`LEGACY_NOTE`); that span becomes the bounded block and whatever follows it stays. When the
 * old note does not match exactly, nothing of it is removed: the bounded block is added at the end
 * and the old note stays where it is.
 *
 * A file Mend cannot read (anything but "absent"), a file that is not valid UTF-8, and a file
 * whose markers do not form exactly one block are never written; the outcome line says which. A
 * rewrite goes to a temporary file beside the real one and is renamed over it, keeping its mode.
 * A symlinked file is written at its target; a file with several hard links is written in place.
 */

import { shellQuote } from "./workspace-files.ts";

/** The line that opens Mend's block. Recognised by this prefix, so the hint may change. */
export const WORKSPACE_NOTE_BEGIN = "<!-- mend:workspace-note:begin";
/** The line that closes Mend's block. */
export const WORKSPACE_NOTE_END = "<!-- mend:workspace-note:end";

const BEGIN_LINE = `${WORKSPACE_NOTE_BEGIN} · Mend rewrites this block at every launch; keep your own notes outside it -->`;
const END_LINE = `${WORKSPACE_NOTE_END} -->`;

/** The marker line of the old open-ended note. */
export const LEGACY_NOTE_MARKER = "<!-- mend:mounts -->";

/**
 * Every fixed line Mend's open-ended note generators wrote, from the first (2026-08-01) to the
 * last. Frozen: these are history, and the current note's wording lives in the engine.
 * - `header`: what followed the marker line.
 * - `headings`: a section's first line, followed by a blank line and one bullet per mount.
 * - `suffixes`: what could follow a mount path on its bullet.
 * - `services`: the Services section, heading through its closing blank line.
 * - `declared`: the optional line naming declared recipes, and its closing blank line.
 */
export const LEGACY_NOTE = {
  header: "## Mend mounts\n\nMounted beside the repo:\n\n",
  headings: [
    "Read-only clones of dependency sources — read the actual source here before guessing a dependency's API:",
    "Linked repositories — sibling projects, read-write. Commits there are that repository's own change, reviewed on its side, not part of this session's change:",
    "Project folders from the user's machine:",
    "Project folders beside the repository:",
  ],
  suffixes: [
    " (read-only)",
    " (read-write — writes land on the user's folder directly and are not part of the reviewed change)",
    " (read-write — writes land in the folder directly and are not part of the reviewed change)",
  ],
  services: [
    "## Mend Services\n\nFor any long-running server (dev server, database), use `mend service run --port <port> [--name <n>] -- <command...>` — it runs the command supervised in this workspace, waits for the port, and makes it reachable from the user's own machine. NEVER background a server inside a tool call. `mend service add <port>` adopts something already listening; `mend service list` shows what runs.\n\n",
    "## Mend Services\n\nFor any long-running server (dev server, database), use `mend service run --port <port> [--name <n>] -- <command...>` — it runs the command supervised in this workspace, waits for the port, and makes it reachable from the user's own machine. NEVER background a server inside a tool call. Listen on IPv4 — `127.0.0.1` or `0.0.0.0`: the forward dials the workspace's `127.0.0.1`, so a server bound only to `::1` reports healthy and answers nothing (Vite and friends: pass `--host`). In a monorepo, run the ONE app's own dev command (`pnpm --dir apps/<app> dev`): a root-level dev script fans out to every app and hands each the same `--port`, so they collide and drift onto ports nobody asked for. `mend service add <port>` adopts something already listening; `mend service list` shows what runs.\n\n",
    "## Mend Services\n\nFor any long-running server (dev server, database), use `mend service run --port <port> [--name <n>] [--http|--https] -- <command...>` — it runs the command supervised in this workspace, waits for the port, and makes it reachable from the user's own machine. Pass `--http` (or `--https`) when the server is something to open in a browser: the user then gets an Open link. NEVER background a server inside a tool call. Listen on IPv4 — `127.0.0.1` or `0.0.0.0`: the forward dials the workspace's `127.0.0.1`, so a server bound only to `::1` reports healthy and answers nothing (Vite and friends: pass `--host`). In a monorepo, run the ONE app's own dev command (`pnpm --dir apps/<app> dev`): a root-level dev script fans out to every app and hands each the same `--port`, so they collide and drift onto ports nobody asked for. `mend service add <port> [--http|--https]` adopts something already listening; `mend service list` shows what runs.\n\n",
    "## Mend Services\n\nFor any long-running server (dev server, database), use `mend service run --port <port> [--name <n>] [--http|--https] -- <command...>` — it runs the command supervised in this workspace, waits for the port, and makes it reachable from the user's own machine. Pass `--http` (or `--https`) when the server is something to open in a browser: the user then gets an Open link, and an attached `mend` terminal on their machine tunnels it to their localhost. NEVER background a server inside a tool call. Listen on IPv4 — `127.0.0.1` or `0.0.0.0`: the forward dials the workspace's `127.0.0.1`, so a server bound only to `::1` reports healthy and answers nothing (Vite and friends: pass `--host`). In a monorepo, run the ONE app's own dev command (`pnpm --dir apps/<app> dev`): a root-level dev script fans out to every app and hands each the same `--port`, so they collide and drift onto ports nobody asked for. `mend service add <port> [--http|--https]` adopts something already listening; `mend service list` shows what runs.\n\n",
  ],
  declared:
    "^Declared Services \\(mend\\.toml(?: \\+ project)?\\): [^\\n]* — start one with `mend service run <name>`\\.\\n\\n",
} as const;

/** The harness memory files the note goes into, relative to `$HOME`. */
export const WORKSPACE_NOTE_FILES = [".claude/CLAUDE.md", ".codex/AGENTS.md"] as const;

/** The whole block for `body`: begin line, body, end line, each line ending in a newline. */
export const workspaceNoteBlock = (body: string): string =>
  `${BEGIN_LINE}\n${body.endsWith("\n") ? body : `${body}\n`}${END_LINE}\n`;

/**
 * The program that merges the block into each file (`node -e`, argv: block, then the files). It
 * prints one `note <outcome> <detail> <file>` line per file (`detail` is an error code or `-`):
 * - `created`: the file was absent and now holds the block.
 * - `replaced`: the one block was replaced; everything outside it is unchanged.
 * - `migrated`: the old note matched exactly and became the block; what followed it stays.
 * - `appended`: no block yet; the block was added at the end.
 * - `appended-legacy-kept`: as `appended`, and an old note that did not match exactly stays.
 * - `unchanged`: the file already says this; nothing was written.
 * - `ambiguous`: the markers do not form exactly one block; nothing was written.
 * - `unreadable`: reading failed, or the bytes are not UTF-8; nothing was written.
 * - `dangling`: the file is a symlink to nothing; nothing was written.
 * - `failed`: the write failed; the temporary file is removed and the file is as it was.
 */
export const WORKSPACE_NOTE_PROGRAM = [
  `const fs=require("fs"),path=require("path");`,
  `const L=${JSON.stringify(LEGACY_NOTE)};`,
  `const BEGIN=${JSON.stringify(WORKSPACE_NOTE_BEGIN)},END=${JSON.stringify(WORKSPACE_NOTE_END)},MARK=${JSON.stringify(LEGACY_NOTE_MARKER)};`,
  `const DECLARED=new RegExp(L.declared);`,
  `const [block,...files]=process.argv.slice(1);`,
  // Lines with their byte offsets; `end` includes the newline.
  `function lines(s){const out=[];let i=0;while(i<s.length){const j=s.indexOf("\\n",i);const e=j<0?s.length:j+1;out.push({start:i,end:e,text:s.slice(i,j<0?s.length:j)});i=e}return out}`,
  `function bullet(line){if(!line.startsWith("- /"))return false;let rest=line;for(const x of L.suffixes){if(rest.endsWith(x)){rest=rest.slice(0,-x.length);break}}return /^- \\/\\S+$/.test(rest)}`,
  // The old note from its marker line: null when there is none, end -1 when it is not exactly
  // what a generator wrote. `start` takes the newline the generator put before the marker.
  `function legacy(s){let m=-1;if(s.startsWith(MARK+"\\n"))m=0;else{const k=s.indexOf("\\n"+MARK+"\\n");if(k>=0)m=k+1}if(m<0)return null;`,
  `const start=m>0?m-1:0;let p=m+MARK.length+1;const no={start,end:-1};`,
  `if(!s.startsWith(L.header,p))return no;p+=L.header.length;`,
  `let sections=0;for(;;){const h=L.headings.find(h=>s.startsWith(h+"\\n\\n",p));if(h===undefined)break;let q=p+h.length+2,n=0;`,
  `for(;;){const e=s.indexOf("\\n",q);if(e<0||!bullet(s.slice(q,e)))break;n++;q=e+1}`,
  `if(n===0||s[q]!=="\\n")return no;p=q+1;sections++}`,
  `if(s.startsWith("\\n## Mend Services\\n",p)){const v=L.services.find(v=>s.startsWith("\\n"+v,p));if(v===undefined)return no;p+=1+v.length;`,
  `const d=DECLARED.exec(s.slice(p));if(d)p+=d[0].length;return {start,end:p}}`,
  // The first generator wrote no Services section, and only with a mount to name. A Services
  // section further down means the note was edited in between: none of it is removed.
  `if(sections===0||s.includes("\\n## Mend Services\\n\\nFor any long-running server",p))return no;`,
  `return {start,end:p}}`,
  `function merge(s){if(s===null)return {text:block,outcome:"created"};const ls=lines(s);`,
  `const b=ls.filter(l=>l.text.startsWith(BEGIN)),e=ls.filter(l=>l.text.startsWith(END));`,
  `if(b.length===1&&e.length===1&&b[0].start<e[0].start){let text=s.slice(0,b[0].start)+block+s.slice(e[0].end);`,
  // An old note a previous Mend appended after the block goes, when it matches exactly.
  `const o=legacy(text);if(o!==null&&o.end>=0&&o.start>=b[0].start+block.length)text=text.slice(0,o.start)+text.slice(o.end);return {text,outcome:"replaced"}}`,
  `if(b.length!==0||e.length!==0)return {text:s,outcome:"ambiguous"};`,
  `const o=legacy(s);if(o!==null&&o.end>=0){const pre=s.slice(0,o.start);return {text:pre+(pre===""?"":"\\n")+block+s.slice(o.end),outcome:"migrated"}}`,
  `return {text:s+(s===""?"":s.endsWith("\\n")?"\\n":"\\n\\n")+block,outcome:o===null?"appended":"appended-legacy-kept"}}`,
  `function write(f,st,text){if(st===null){fs.writeFileSync(f,text,{flag:"wx",mode:0o644});return}`,
  `const real=fs.realpathSync(f),rs=fs.statSync(real);if(rs.nlink>1){fs.writeFileSync(real,text);return}`,
  `const tmp=path.join(path.dirname(real),"."+path.basename(real)+".mend-note-"+process.pid);`,
  `try{const fd=fs.openSync(tmp,"wx",rs.mode&0o7777);try{fs.writeFileSync(fd,text);fs.fchmodSync(fd,rs.mode&0o7777);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(tmp,real)}`,
  `catch(err){try{fs.unlinkSync(tmp)}catch{}throw err}}`,
  `function report(o,f,d){process.stdout.write("note "+o+" "+(d||"-")+" "+f+"\\n")}`,
  `for(const f of files){let st=null;try{st=fs.lstatSync(f)}catch(err){if(err.code!=="ENOENT"){report("unreadable",f,err.code);continue}}`,
  `let s=null;if(st!==null){let buf;try{buf=fs.readFileSync(f)}catch(err){report(err.code==="ENOENT"?"dangling":"unreadable",f,err.code);continue}`,
  `s=buf.toString("utf8");if(!Buffer.from(s,"utf8").equals(buf)){report("unreadable",f,"not-utf8");continue}}`,
  `const r=merge(s);if(r.outcome==="ambiguous"){report("ambiguous",f);continue}if(r.text===s){report("unchanged",f);continue}`,
  `try{write(f,st,r.text);report(r.outcome,f)}catch(err){report("failed",f,err.code||"error")}}`,
].join("");

/**
 * The exec that writes `body` as Mend's block into every harness memory file under `$HOME`.
 * The block rides as `$1`; the program and the paths are fixed.
 */
export const workspaceNoteExec = (body: string): ReadonlyArray<string> => [
  "sh",
  "-c",
  `mkdir -p "$HOME/.claude" "$HOME/.codex"; ` +
    `node -e ${shellQuote(WORKSPACE_NOTE_PROGRAM)} "$1" ` +
    WORKSPACE_NOTE_FILES.map((file) => `"$HOME/${file}"`).join(" "),
  "mend-note",
  workspaceNoteBlock(body),
];

/** What the program did with one file. */
export interface WorkspaceNoteOutcome {
  readonly outcome: string;
  readonly file: string;
  readonly detail: string | null;
}

/** Outcomes that mean the file was left exactly as it was because Mend could not be sure. */
export const WORKSPACE_NOTE_NOT_WRITTEN: ReadonlySet<string> = new Set([
  "ambiguous",
  "unreadable",
  "dangling",
  "failed",
]);

/** The `note …` lines one run printed. The file comes last: `$HOME` may hold spaces. */
export const parseWorkspaceNoteOutcomes = (stdout: string): ReadonlyArray<WorkspaceNoteOutcome> =>
  stdout.split("\n").flatMap((line): ReadonlyArray<WorkspaceNoteOutcome> => {
    const match = /^note (\S+) (\S+) (.+)$/.exec(line);
    if (match === null) return [];
    const detail = match[2] ?? "-";
    return [
      { outcome: match[1] ?? "", file: match[3] ?? "", detail: detail === "-" ? null : detail },
    ];
  });
