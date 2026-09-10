import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { ServerProcessOptions, ServerProcessOutput } from "../src/server-runtime.ts";

type Labels = Readonly<Record<string, string>> | null;
interface Image {
  readonly Id: string;
  readonly Config: { readonly Labels: Readonly<Record<string, string>> };
}

const ok = (stdout = ""): ServerProcessOutput => ({ status: 0, stdout, stderr: "" });
const failed = (stderr: string): ServerProcessOutput => ({ status: 1, stdout: "", stderr });

/** Stateful Engine protocol for setup tests. Share one instance to share daemon data across configs.
 * Named create preserves labels; registry copies survive local tag removal. Unhandled commands
 * return undefined so callers can supply capability/Compose responses, never a blanket success.
 */
export class DockerProtocol {
  /** Existing named resources, including legacy/unlabelled data. */
  readonly volumes = new Map<string, Labels>();
  /** Existing containers for the pre-claim project check. */
  readonly containers = new Map<string, Labels>();
  /** Existing networks for the pre-claim project check. */
  readonly networks = new Map<string, Labels>();
  /** Local image tags, distinct from registry manifests. */
  readonly local = new Map<string, Image>();
  /** Registry manifests retained across local removal and retries. */
  readonly remote = new Map<string, Image>();
  /** Actual archives imported through the process interface. */
  readonly archives: Array<{ readonly file: string; readonly bytes: Buffer }> = [];
  /** Process requests, including deadlines for probe and cleanup. */
  readonly calls: Array<{
    readonly args: ReadonlyArray<string>;
    readonly timeoutMs: number | undefined;
  }> = [];
  /** Optional transport failures, applied before a command's effects. */
  response: (
    args: ReadonlyArray<string>,
    timeoutMs: number | undefined,
  ) => ServerProcessOutput | undefined = () => undefined;

  /** Handle volume discovery/claim and image roundtrip commands against this daemon's state. */
  run(
    command: string,
    args: ReadonlyArray<string>,
    options?: ServerProcessOptions,
  ): ServerProcessOutput | undefined {
    if (command !== "docker" || args[0] !== "--context") return undefined;
    const [kind, operation] = args.slice(2);
    if (!["volume", "container", "network", "image"].includes(kind ?? "")) return undefined;
    // Offline release-image inspections belong to the caller's capability fixture.
    if (kind === "image" && operation === "inspect" && !args[4]?.includes("/mend-registry-probe/"))
      return undefined;
    this.calls.push({ args, timeoutMs: options?.timeoutMs });
    const replacement = this.response(args, options?.timeoutMs);
    if (replacement !== undefined) return replacement;
    const collection =
      kind === "volume"
        ? this.volumes
        : kind === "container"
          ? this.containers
          : kind === "network"
            ? this.networks
            : undefined;
    if (collection !== undefined) {
      if (operation === "ls") {
        const filter = args.indexOf("--filter");
        const value = filter < 0 ? undefined : args[filter + 1];
        const project = value?.startsWith("label=com.docker.compose.project=")
          ? value.replace("label=com.docker.compose.project=", "")
          : undefined;
        const namePattern = value?.startsWith("name=")
          ? new RegExp(value.replace("name=", ""))
          : undefined;
        const bare =
          args.indexOf("--format") >= 0 && args[args.indexOf("--format") + 1] === "{{.Names}}";
        return ok(
          [...collection]
            .filter(
              ([name, labels]) =>
                (project === undefined || labels?.["com.docker.compose.project"] === project) &&
                (namePattern === undefined || namePattern.test(name)),
            )
            .map(([name]) => (bare ? name : JSON.stringify(name)))
            .join("\n"),
        );
      }
      if (kind === "volume" && operation === "rm") {
        const names = args.slice(4);
        const missing = names.filter((name) => !collection.has(name));
        if (missing.length > 0) return failed(`No such volume: ${missing.join(", ")}`);
        for (const name of names) collection.delete(name);
        return ok(names.join("\n"));
      }
      if (kind === "volume" && operation === "create") {
        const name = args.at(-1);
        const label = args[args.indexOf("--label") + 1];
        if (name === undefined || label === undefined) return failed("Missing name or label");
        const separator = label.indexOf("=");
        if (!collection.has(name))
          collection.set(name, { [label.slice(0, separator)]: label.slice(separator + 1) });
        return ok(name);
      }
      if (operation === "inspect") {
        const name = args[4] ?? "";
        const format =
          kind === "volume"
            ? "{{json .}}"
            : `{"Name":{{json .Name}},"Labels":{{json .${kind === "container" ? "Config.Labels" : "Labels"}}}}`;
        if (args.at(-1) !== format) return failed("Unexpected inspection format");
        return collection.has(name)
          ? ok(
              JSON.stringify({
                Name: kind === "container" ? `/${name}` : name,
                Labels: collection.get(name),
              }),
            )
          : failed("No such resource");
      }
    }
    if (kind === "image") {
      if (options?.timeoutMs === undefined || options.timeoutMs <= 0)
        return failed("Probe requires a deadline");
      const reference = args.at(-1) ?? "";
      if (operation === "ls") {
        const exact = args[args.indexOf("--filter") + 1]?.replace("reference=", "") ?? "";
        const image = this.local.get(exact);
        return ok(image === undefined ? "" : JSON.stringify(image.Id));
      }
      if (operation === "import") {
        const file = args.at(-2) ?? "";
        if (
          (fs.statSync(file).mode & 0o777) !== 0o600 ||
          (fs.statSync(path.dirname(file)).mode & 0o777) !== 0o700
        )
          return failed("Probe archive must be private");
        const bytes = fs.readFileSync(file);
        const label = (args[args.indexOf("--change") + 1] ?? "").replace(/^LABEL /, "");
        const separator = label.indexOf("=");
        const image = {
          Id: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          Config: { Labels: { [label.slice(0, separator)]: label.slice(separator + 1) } },
        };
        this.archives.push({ file, bytes });
        this.local.set(reference, image);
        return ok(image.Id);
      }
      if (operation === "inspect") {
        const image = this.local.get(args[4] ?? "");
        return image === undefined ? failed("No such image") : ok(JSON.stringify(image));
      }
      if (operation === "push") {
        const image = this.local.get(reference);
        if (image === undefined) return failed("No local tag");
        this.remote.set(reference, image);
        return ok();
      }
      if (operation === "rm") return this.local.delete(reference) ? ok() : failed("No local tag");
      if (operation === "pull") {
        const image = this.remote.get(reference);
        if (image === undefined) return failed("Registry manifest missing");
        if (this.local.has(reference)) return failed("Probe must remove local tag before pull");
        this.local.set(reference, image);
        return ok();
      }
    }
    return failed(`Unexpected Docker protocol command: ${args.join(" ")}`);
  }
}
