import type { ExposureGateItem, MultiModeGateItem, PreviewProblem } from "@mend/api-contracts";
import {
  boatKeyStatusLine,
  reportRefusal,
  type ServerBoatFacts,
  type StatusLine,
} from "@mend/domain/workbench";

import { ago } from "./boat-key.ts";

/**
 * What Settings → Server says about the server its operators run (docs/adr/0025: the Server's home
 * is read-only in the app, changed with `mend server setup` or Helm). It answers three questions in
 * order: what this server is, whether anything needs the operator, and what it offers. Every
 * sentence says what the operator told Mend or what Mend saw, never a verdict (docs/adr/0004).
 *
 * The checks (`GET /operator/exposure`, `GET /operator/gate`) are worded here from each item's case
 * and its data, not from the server's `detail` and `fix`, which are the command line's.
 */

// ---------------------------------------------------------------------------------------------
// Words: sentences with machine facts in them

/** A machine fact inside a sentence (an address, a variable, a command): drawn in mono. */
export interface Code {
  readonly code: string;
}

/** A sentence, or a few, as plain text and machine facts in order. */
export type Words = ReadonlyArray<string | Code>;

export const code = (text: string): Code => ({ code: text });

type Piece = string | number | Code | Words;

const pieces = (piece: Piece): Words =>
  typeof piece === "string" || typeof piece === "number"
    ? [String(piece)]
    : "code" in piece
      ? [piece]
      : piece;

/** A sentence written as a template: strings and numbers stay text, a `code(…)` stays mono. */
const w = (strings: TemplateStringsArray, ...values: ReadonlyArray<Piece>): Words =>
  strings.flatMap((text, index) => {
    const value = values[index];
    return [...(text === "" ? [] : [text]), ...(value === undefined ? [] : pieces(value))];
  });

/** Sentences one after another, a space between them. */
const join = (...sentences: ReadonlyArray<Words>): Words =>
  sentences.flatMap((sentence, index) => (index === 0 ? sentence : [" ", ...sentence]));

/** "a", "a and b", "a, b and c", each in mono. */
const codes = (items: ReadonlyArray<string>): Words =>
  items.flatMap((item, index) => [
    ...(index === 0 ? [] : index === items.length - 1 ? [" and "] : [", "]),
    code(item),
  ]);

/**
 * Each part with a key of its own for a list: its kind and text, numbered when the same part comes
 * again, so the keys hold however the words are cut.
 */
export const keyedParts = (
  words: Words,
): ReadonlyArray<{ readonly key: string; readonly part: string | Code }> => {
  const seen = new Map<string, number>();
  return words.map((part) => {
    const base = typeof part === "string" ? `text:${part}` : `code:${part.code}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return { key: `${base}#${count}`, part };
  });
};

/** The words as text, machine facts in backticks: what a test or a screen reader compares. */
export const wordsText = (words: Words): string =>
  words.map((part) => (typeof part === "string" ? part : `\`${part.code}\``)).join("");

const NUMBERS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/** "one", "two" … "nine", then digits: a count read inside a sentence. */
const numberWord = (count: number): string => NUMBERS[count] ?? String(count);

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** "one check", "5 checks": one as a word, any other count in digits. */
const counted = (count: number, one: string, many: string): string =>
  count === 1 ? `one ${one}` : `${count} ${many}`;

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

/** "on 13 Nov at 10:46", or "today at 10:46". */
export const whenChecked = (at: Date, now: Date): string => {
  const clock = at.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (at.toDateString() === now.toDateString()) return `today at ${clock}`;
  const day = at.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return `on ${day} at ${clock}`;
};

// ---------------------------------------------------------------------------------------------
// How this server is changed

export type Deployment = "local" | "kubernetes";

/** How an operator changes the server: setup on one machine, Helm on Kubernetes. */
export const changeHow = (mode: Deployment | null): string =>
  mode === "kubernetes"
    ? "edit your Helm values and upgrade the release"
    : mode === "local"
      ? "run mend server setup on the server"
      : "run mend server setup on the server, or edit your Helm values and upgrade the release";

/** What the page knows beside a check: where the server runs, and the address it was opened at. */
export interface CheckContext {
  /** One machine or Kubernetes, from `/health`; null while it hasn't loaded. */
  readonly deployment: Deployment | null;
  /** The address the browser opened Mend at; empty while the page renders on the server. */
  readonly address: string;
}

const onKubernetes = (context: CheckContext): boolean => context.deployment === "kubernetes";

/** The items Helm's `exposure.declared` takes (deploy/helm/mend/templates/api.yaml). */
const HELM_DECLARABLE: ReadonlySet<string> = new Set([
  "core-private",
  "edge-tls",
  "t3code-gateway",
  "preview-gateway",
]);

/** How the operator tells Mend they checked an item from outside: setup, or Helm's list. */
const declareStep = (id: string, context: CheckContext): Words =>
  onKubernetes(context) && HELM_DECLARABLE.has(id)
    ? w`add ${code(id)} to ${code("exposure.declared")} in your Helm values`
    : w`run ${code(`mend server setup --declare ${id}`)}`;

/** A setting: its variable on one machine, its key in the Helm values on Kubernetes. */
const setting = (context: CheckContext, variable: string, helm: string): Words =>
  onKubernetes(context) ? w`set ${code(helm)} in your Helm values` : w`set ${code(variable)}`;

/** The same words with their first letter capitalised, to start a sentence. */
const opening = (words: Words): Words => {
  const [first, ...rest] = words;
  return typeof first === "string" ? [capital(first), ...rest] : words;
};

const theAddress = (context: CheckContext): Words =>
  context.address === "" ? ["your address"] : [code(context.address)];

// ---------------------------------------------------------------------------------------------
// The checks

/** A check as the page shows it: a plain title, what Mend saw, and what would change it. */
export interface CheckWords {
  /** The server's id for it: small and muted beside the title, for searching the docs. */
  readonly id: string;
  readonly title: string;
  readonly saw: Words;
  /** What to do when it isn't in place; for a check Mend can't make itself, how to check it. */
  readonly fix: Words | null;
  readonly inPlace: boolean;
  /** An exposure check that, while not in place, stops Mend starting in public. */
  readonly blocksStart: boolean;
}

const TOLD = "It can't check that.";

const told = (declared: boolean, yes: Words, no: Words): Words => (declared ? yes : no);

const coreServices = (mirrors: ReadonlyArray<string>, and: "and" | "or"): Words =>
  mirrors.length === 0
    ? [`Sealant, its registry ${and} the database`]
    : w`Sealant, its registry, the database ${and} the package mirrors (${codes(mirrors)})`;

const previewProblem = (problem: PreviewProblem): { readonly saw: Words; readonly fix: Words } => {
  switch (problem.kind) {
    case "plain-http":
      return {
        saw: w`Previews are plain HTTP at ${code(problem.url)}, and ${
          problem.because === "exposure-not-loopback"
            ? "this server isn't set to this machine only"
            : "the gateway is reached from beyond this machine"
        }.`,
        fix: w`Set ${code("MEND_PREVIEW_DOMAIN")} to serve previews over HTTPS behind your proxy.`,
      };
    case "domain-overlap":
      return {
        saw: w`Mend's address ${code(problem.host)} sits ${problem.overlap} ${code(problem.domain)}.`,
        fix: w`Set ${code("MEND_PREVIEW_DOMAIN")} to a domain apart from Mend's.`,
      };
    case "cookies":
      return {
        saw: w`Mend's cookies aren't ${code("__Host-")}, and previews share Mend's site.`,
        fix: w`Set ${code("APP_URL")} to an https address.`,
      };
    case "tailnet-public":
      return {
        saw: [
          "Previews are on a tailnet, and this server is public. A tailnet's names are one site, not a domain of the previews' own.",
        ],
        fix: w`Serve previews under a domain of their own (${code("MEND_PREVIEW_DOMAIN")}), or keep this server private.`,
      };
    case "published-mismatch":
      return {
        saw: w`The preview gateway listens on ${code(problem.listener)}, but ${code("MEND_PREVIEW_PUBLISHED")} says ${code(problem.published)}.`,
        fix: w`Run ${code("mend server setup")} again, or set ${code("MEND_PREVIEW_PUBLISHED")} to where the gateway's port is published.`,
      };
  }
};

const previewOutside = (
  item: Extract<ExposureGateItem, { readonly id: "preview-gateway" }>,
  context: CheckContext,
): { readonly told: Words; readonly cannot: Words; readonly fix: Words } | null => {
  switch (item.reason) {
    case "loopback-http":
      return null;
    case "domain-https": {
      const wildcard = code(`*.${item.domain}`);
      const site =
        item.sharedSite === null
          ? []
          : w` It also can't see whether the other hosts on ${code(item.sharedSite)} keep their sign-ins in ${code("__Host-")} cookies.`;
      return {
        told: w`You told Mend the wildcard DNS and certificate for ${wildcard} are in place, and who can reach the gateway's port. ${TOLD}`,
        cannot: w`Mend can't see the wildcard DNS and certificate for ${wildcard}, or who reaches the gateway's port.${site}`,
        fix: w`Open a preview from another network, then ${declareStep("preview-gateway", context)}.`,
      };
    }
    case "tailnet-https":
      return {
        told: w`You told Mend the Tailscale steps for ${code(item.hostname)} are done, and who can reach the gateway's port. ${TOLD}`,
        cannot: w`Mend can't see the Tailscale steps for ${code(item.hostname)}, or who reaches the gateway's port.`,
        fix: w`Open a preview from a device on the tailnet and from one outside it, then ${declareStep("preview-gateway", context)}.`,
      };
  }
};

const previewWords = (
  item: Extract<ExposureGateItem, { readonly id: "preview-gateway" }>,
  context: CheckContext,
): Pick<CheckWords, "saw" | "fix"> => {
  const problems = item.problems.map(previewProblem);
  const outside = previewOutside(item, context);
  const sharesSite =
    (item.reason === "domain-https" && item.sharedSite !== null) || item.reason === "tailnet-https";
  if (problems.length === 0 && item.outside !== "open") {
    return {
      saw: join(
        w`Previews are served at ${code(item.pattern)}, apart from Mend's own address.`,
        ...(sharesSite
          ? [w`Mend's cookies start with ${code("__Host-")}, so a preview can't set them.`]
          : []),
        ...(outside !== null && item.outside === "declared" ? [outside.told] : []),
      ),
      fix: null,
    };
  }
  const open = item.outside === "open" && outside !== null ? [outside] : [];
  return {
    saw: join(...problems.map((problem) => problem.saw), ...open.map((each) => each.cannot)),
    fix: join(...problems.map((problem) => problem.fix), ...open.map((each) => each.fix)),
  };
};

/** One exposure check, worded for a person from its case and data. */
export const exposureCheck = (item: ExposureGateItem, context: CheckContext): CheckWords => {
  const declared = item.established === "declared";
  const words = ((): Omit<CheckWords, "id" | "inPlace" | "blocksStart"> => {
    switch (item.id) {
      case "https-origin":
        return {
          title: "Requests arrive over HTTPS",
          saw:
            item.reason === "all-https"
              ? ["Every address browsers open Mend from uses HTTPS."]
              : w`Browsers can still open Mend over plain HTTP from ${codes(item.origins)}.`,
          fix: w`Set ${code("APP_URL")} and every entry in ${code("MEND_ALLOWED_ORIGINS")} to an https address.`,
        };
      case "secure-cookies":
        return {
          title: "Sign-in cookies are HTTPS-only",
          saw:
            item.reason === "secure"
              ? [
                  "Mend's sign-in cookies are Secure, HttpOnly and SameSite=Lax, so browsers send them over HTTPS only.",
                ]
              : w`Mend's sign-in cookies aren't marked Secure, because ${code("APP_URL")} starts with http, so a browser would send them over plain HTTP.`,
          fix: w`Set ${code("APP_URL")} to an https address.`,
        };
      case "trusted-proxies":
        return {
          title: "Mend knows which proxies to trust",
          saw:
            item.reason === "ranges"
              ? [
                  `Mend trusts ${counted(item.rangeCount, "proxy range", "proxy ranges")} to tell it each person's real address.`,
                ]
              : item.reason === "unset"
                ? w`${code("MEND_TRUSTED_PROXIES")} isn't set, so Mend counts everyone who comes through your proxy as one address.`
                : w`${code("MEND_TRUSTED_PROXIES")} trusts every address, so anyone can tell Mend which address to count them as.`,
          fix: opening(
            w`${setting(context, "MEND_TRUSTED_PROXIES", "api.trustedProxyCidrs")} to the address ranges of your proxy and the web tier, and nothing wider.`,
          ),
        };
      case "enrollment-closed":
        return {
          title: "Sign-up is closed",
          saw: [
            "After the first account, people join only by invitation. This is built into this version of Mend, and the server can't see it working from inside.",
          ],
          fix: [
            "To check it yourself, try to sign up without an invitation from another network. Mend should refuse.",
          ],
        };
      case "tenancy-gate":
        return {
          title: "Ready for several organizations",
          saw:
            item.reason === "complete"
              ? ["Everything Mend needs before it runs several organizations is in place."]
              : [
                  `${capital(numberWord(item.missing.length))} of the ${item.total} things Mend needs before it runs several organizations ${item.missing.length === 1 ? "is" : "are"} missing. They're listed under Organizations.`,
                ],
          fix: w`Fix them there, or run ${code("mend operator gate")} on the server to list them.`,
        };
      case "budgets":
        return {
          title: "Usage budgets are on",
          saw:
            item.reason === "all-set"
              ? ["Every usage budget has a limit."]
              : item.variables.length === 1
                ? w`This budget is off: ${codes(item.variables)}.`
                : w`These budgets are off: ${codes(item.variables)}.`,
          fix: ["Unset each one to use its default, or set it to a positive number."],
        };
      case "no-bearers-in-urls":
        return {
          title: "Tokens stay out of addresses",
          saw:
            item.reason === "refused"
              ? [
                  "Mend refuses a sign-in token inside an address. Clients open live connections with a one-time ticket instead.",
                ]
              : [
                  "Mend still accepts a sign-in token inside an address, for clients older than upgrade tickets.",
                ],
          fix: w`Once the CLI, VS Code and phone builds you use are up to date, ${setting(context, "MEND_URL_BEARERS=refuse", "exposure.refuseUrlBearers: true")}.`,
        };
      case "browser-headers":
        return {
          title: "Browser security headers",
          saw: [
            "This version's web server sets the headers browsers read. The server can't see which web server is in front of it, so it can't check what browsers receive.",
          ],
          fix: w`${code("mend doctor")} against your address reads the headers a browser gets.`,
        };
      case "error-redaction":
        return {
          title: "Errors hide internal detail",
          saw:
            item.reason === "redacted"
              ? ["Error responses leave out detail from the services behind Mend."]
              : w`${code("MEND_ERROR_DETAIL=verbose")} is set, so error responses include detail from the services behind Mend.`,
          fix: w`Unset ${code("MEND_ERROR_DETAIL")}.`,
        };
      case "executor-channel-transport":
        return {
          title: "How workspaces connect to Mend",
          saw:
            item.reason === "socket"
              ? [
                  "Workspaces reach their session over a socket on this machine, not over a network.",
                ]
              : item.reason === "https"
                ? ["Workspaces reach their session over HTTPS."]
                : item.reason === "plain-http-private"
                  ? w`Workspaces reach their session over plain HTTP. You told Mend they do it over a private network (${code("MEND_EXECUTOR_NETWORK=private")}). ${TOLD}`
                  : ["Workspaces reach their session over plain HTTP."],
          fix: w`Serve the session channel over HTTPS. If workspaces reach it over a network you control, ${setting(context, "MEND_EXECUTOR_NETWORK=private", "exposure.executorNetwork: private")} instead.`,
        };
      case "workspace-ssh":
        return {
          title: "Workspace SSH",
          saw:
            item.reason === "unpublished"
              ? ["Workspace SSH isn't published on a port of its own."]
              : item.reason === "loopback"
                ? w`Workspace SSH is published on ${code(item.published)} only, on this machine.`
                : told(
                    declared,
                    w`Workspace SSH is published on ${code(item.published)}. You told Mend who can reach it. ${TOLD}`,
                    w`Workspace SSH is published on ${code(item.published)}, apart from the web address. Mend can't see who can reach that port.`,
                  ),
          fix:
            item.reason === "published"
              ? w`Try to connect to ${code(item.published)} from each network that shouldn't reach it. Then ${declareStep("workspace-ssh", context)}, or publish SSH on this machine only.`
              : null,
        };
      case "core-private":
        return {
          title: "Internal services are off the Internet",
          saw: told(
            declared,
            w`You told Mend that ${coreServices(item.mirrors, "and")} can't be reached from the Internet. ${TOLD}`,
            w`Mend can't see whether ${coreServices(item.mirrors, "or")} can be reached from the Internet.`,
          ),
          fix: w`From outside your network, try to connect to each one. When none answers, ${declareStep("core-private", context)}.`,
        };
      case "edge-tls":
        return {
          title: "HTTPS certificate and redirect",
          saw: told(
            declared,
            [
              `You told Mend your proxy's certificate chains to a public root and renews, and that port 80 redirects to HTTPS. ${TOLD}`,
            ],
            [
              "Mend can't see your proxy's certificate, whether it renews, or whether port 80 redirects to HTTPS.",
            ],
          ),
          fix: w`Run ${code("mend doctor")} against ${theAddress(context)} from another network. When it passes, ${declareStep("edge-tls", context)}.`,
        };
      case "t3code-gateway":
        return { title: "T3 Code gateway", ...t3Words(item, declared, context) };
      case "preview-gateway":
        return { title: "Previews", ...previewWords(item, context) };
      case "reassessment":
        return {
          title: "Security review of this version",
          saw:
            item.reason === "reviewed"
              ? w`You told Mend about an independent security review of ${code(item.version)}.`
              : item.reason === "none"
                ? w`Mend knows of no independent security review of ${code(item.version)}.`
                : item.reason === "older"
                  ? w`The last review Mend knows of is for ${code(item.reviewed)}, and this server runs ${code(item.version)}.`
                  : ["This build has no version number, so no review can name it."],
          fix:
            item.reason === "unversioned"
              ? ["Run a released build."]
              : w`After an independent security review of this exact release, ${setting(context, `MEND_EXPOSURE_REASSESSED=${item.version}`, `exposure.reassessedVersion: ${item.version}`)}. Each upgrade needs a new review.`,
        };
    }
  })();
  const inPlace = item.established !== "open";
  return {
    id: item.id,
    ...words,
    // A check the server can't see working says how to check it, in place or not.
    fix: inPlace && item.established !== "carried" ? null : words.fix,
    inPlace,
    blocksStart: item.blocksStart,
  };
};

const t3Words = (
  item: Extract<ExposureGateItem, { readonly id: "t3code-gateway" }>,
  declared: boolean,
  context: CheckContext,
): Pick<CheckWords, "saw" | "fix"> => {
  const step = declareStep("t3code-gateway", context);
  switch (item.reason) {
    case "loopback":
      return {
        saw: w`The T3 Code gateway's port is published on ${code(item.published)} only, on this machine.`,
        fix: null,
      };
    case "published":
      return {
        saw: told(
          declared,
          w`You told Mend who can reach the T3 Code gateway at ${code(item.published)}. ${TOLD}`,
          w`The T3 Code gateway's port is published on ${code(item.published)}. Every device pairs through Mend, but Mend can't see who can reach the port.`,
        ),
        fix: w`Try to connect to ${code(item.published)} from each network that shouldn't reach it, then ${step}, or publish the port on this machine only.`,
      };
    case "edge":
      return {
        saw: told(
          declared,
          w`You told Mend your proxy serves the T3 Code gateway at ${code(item.url)} with a certificate that chains to a public root. ${TOLD}`,
          w`Your proxy serves the T3 Code gateway at ${code(item.url)}. Mend can't see that address's certificate.`,
        ),
        fix: w`Open ${code(`${item.url}/.well-known/t3/environment`)} from another network and check its certificate. When it passes, ${step}.`,
      };
    case "not-said":
      return {
        saw: told(
          declared,
          [`You told Mend who can reach the T3 Code gateway's port. ${TOLD}`],
          w`The T3 Code gateway is on, on a port of its own, but where it's published wasn't set (${code("MEND_T3_GATEWAY_PUBLISHED")}).`,
        ),
        fix: w`Try to connect to the gateway's port from each network that shouldn't reach it, then ${step}.`,
      };
  }
};

/** One item of the multi mode gate, worded for a person from its case and data. */
export const gateCheck = (item: MultiModeGateItem): CheckWords => {
  const words = ((): Omit<CheckWords, "id" | "inPlace" | "blocksStart"> => {
    switch (item.id) {
      case "cross-organization-authorization":
        return {
          title: "Organizations can't reach each other",
          saw: [
            "Every route checks which organization a request belongs to, and refuses one from another organization before it changes anything.",
          ],
          fix: null,
        };
      case "per-account-resources":
        return {
          title: "Personal things stay with one account",
          saw: [
            "Signing keys, push devices, notifications and the GitHub identity each belong to one account.",
          ],
          fix: null,
        };
      case "folders-reach-workspaces":
        return {
          title: "Folders reach workspaces",
          saw:
            item.reason === "captured"
              ? [
                  "Folders and references travel to each workspace as archives, and are laid down beside the worktree. This needs sealantd 0.16.0 or newer.",
                ]
              : ["Folders and references are mounted beside each worktree."],
          fix: null,
        };
      case "source-policy":
        return {
          title: "Mend's git stays off private networks",
          saw:
            item.reason === "tenant"
              ? [
                  "Mend's own git follows the tenant source policy, so it won't fetch from private or local addresses.",
                ]
              : [
                  "Mend's own git follows the operator source policy, so it can fetch from private and local addresses.",
                ],
          fix: w`Set ${code("MEND_SOURCE_POLICY=tenant")}. That also fixes the next one.`,
        };
      case "source-address-pinning":
        return {
          title: "Git connects to the address it checked",
          saw:
            item.reason === "tenant"
              ? ["Git connects to the exact address the source policy checked, over SSH and HTTPS."]
              : [
                  "Under the operator source policy, git looks up names itself, so it can connect to a different address from the one that was checked.",
                ],
          fix: w`Set ${code("MEND_SOURCE_POLICY=tenant")}.`,
        };
      case "transport-bound-to-origin":
        return {
          title: "Workspace git signs only for its own remote",
          saw:
            item.reason === "bound"
              ? ["A workspace's git can sign requests only for its project's remote."]
              : ["A workspace's git can sign requests for any remote."],
          fix: w`Unset ${code("MEND_GIT_TRANSPORT_BIND_ORIGIN")}.`,
        };
      case "upload-length-binding":
        return {
          title: "Uploads are held to their size",
          saw:
            item.reason === "enforced"
              ? [
                  "Every upload from a workspace is signed for its size, and the bucket enforces it.",
                ]
              : item.reason === "no-sizes"
                ? ["Mend accepts uploads from workspaces that don't say how big they are."]
                : ["Mend asks for sizes, but a directory store can't enforce them."],
          fix:
            item.reason === "directory-store"
              ? w`Use an S3-compatible bucket for ${code("MEND_BLOB_STORE")}.`
              : w`Set ${code("MEND_CAPTURE_REQUIRE_SIZES=true")}, and use an S3-compatible bucket for ${code("MEND_BLOB_STORE")}.`,
        };
      case "daemon-declares-sizes":
        return {
          title: "Workspaces say how big each upload is",
          saw: [
            "sealantd says how big every upload is before it asks where to send it. This needs sealantd 0.16.0 or newer.",
          ],
          fix: null,
        };
      case "raw-service-ports":
        return {
          title: "Service ports stay on this machine",
          saw:
            item.reason === "loopback"
              ? [
                  "Services in workspaces listen on this machine only. People reach them through Mend, signed in.",
                ]
              : w`Services in workspaces listen on ${codes(item.addresses)}, where anyone who reaches the port reaches the service without signing in.`,
          fix: w`Unset ${code("MEND_SERVICE_HOSTS")}.`,
        };
      case "operator-present":
        return {
          title: "The server has an operator",
          saw:
            item.count === 0
              ? ["No account holds the operator role."]
              : [
                  `${capital(counted(item.count, "account holds", "accounts hold"))} the operator role.`,
                ],
          fix: ["Give an account the operator role."],
        };
    }
  })();
  return {
    id: item.id,
    ...words,
    fix: item.ok ? null : words.fix,
    inPlace: item.ok,
    blocksStart: false,
  };
};

// ---------------------------------------------------------------------------------------------
// Who can reach it

export type Declared = "loopback" | "private" | "public";

/** What `MEND_EXPOSURE` says, as its row reads it, with what it means beneath. */
export const DECLARED_WORDS: Readonly<
  Record<Declared, { readonly word: string; readonly means: string }>
> = {
  loopback: { word: "This machine only", means: "Only this machine reaches Mend." },
  private: { word: "Private network", means: "You control who can join the network." },
  public: { word: "Public", means: "Anyone on the Internet can reach the address." },
};

/** Where the exposure is set: setup on one machine, the Helm values on Kubernetes. */
export const exposureSetWith = (deployment: Deployment | null): Words =>
  deployment === "kubernetes"
    ? w`Set with ${code("exposure.mode")} in your Helm values.`
    : deployment === "local"
      ? w`Set with ${code("mend server setup --exposure")}.`
      : w`Set with ${code("MEND_EXPOSURE")}.`;

/**
 * The exposure checks, sorted for the page. On a public server every check not in place needs the
 * operator. On a private or loopback one nothing is wrong: the same checks are what would have to
 * change before it could go public, the ones that stop a public start first.
 */
export interface ExposureGroups {
  readonly needsYou: ReadonlyArray<CheckWords>;
  readonly toGoPublic: ReadonlyArray<CheckWords>;
  readonly inPlace: ReadonlyArray<CheckWords>;
}

export const exposureGroups = (
  report: { readonly declared: Declared; readonly items: ReadonlyArray<ExposureGateItem> },
  context: CheckContext,
): ExposureGroups => {
  const checks = report.items.map((item) => exposureCheck(item, context));
  const notInPlace = checks
    .filter((check) => !check.inPlace)
    .toSorted((a, b) => Number(b.blocksStart) - Number(a.blocksStart));
  const inPlace = checks.filter((check) => check.inPlace);
  return report.declared === "public"
    ? { needsYou: notInPlace, toGoPublic: [], inPlace }
    : { needsYou: [], toGoPublic: notInPlace, inPlace };
};

/** The closed line over what a private server would have to change to go public. */
export const goPublicLine = (count: number): string =>
  `Before this server could go public, ${counted(count, "thing", "things")} would have to change.`;

/**
 * The first line of that list once open: which of them stop a public start, and that Mend can't
 * check the rest for itself. The list sorts the ones that stop a start first.
 */
export const goPublicLead = (checks: ReadonlyArray<CheckWords>): string => {
  const blocking = checks.filter((check) => check.blocksStart).length;
  const others = checks.length - blocking;
  if (blocking === 0) {
    return others === 1
      ? "It doesn't stop Mend starting in public. Mend can't check it for itself."
      : "None of them stops Mend starting in public. Mend can't check them for itself.";
  }
  const until =
    others === 0
      ? `Mend won't start in public until ${blocking === 1 ? "it changes" : "they change"}.`
      : `Mend won't start in public until the first ${blocking === 1 ? "one changes" : `${numberWord(blocking)} change`}.`;
  if (others === 0) return until;
  return `${until} It can't check the other ${others === 1 ? "one" : numberWord(others)} for itself.`;
};

/** The closed line over the checks in place: all of them, or the others beside a list above. */
export const inPlaceLine = (inPlace: number, total: number): string =>
  inPlace === total
    ? `All ${total} checks are in place.`
    : inPlace === 1
      ? "One other check is in place."
      : `${inPlace} other checks are in place.`;

// ---------------------------------------------------------------------------------------------
// Organizations and the multi mode gate

export type Tenancy = "single" | "multi";

/** `MEND_TENANCY`, as its row reads it. Helm has no key of its own for it. */
export const TENANCY_WORDS: Readonly<
  Record<Tenancy, { readonly word: string; readonly means: string }>
> = {
  single: { word: "One organization", means: "Everyone who signs in is in the same organization." },
  multi: {
    word: "Several organizations",
    means:
      "Each organization has its own members and projects, and people in one can't see another's.",
  },
};

/** The gate's items, sorted for the page as the exposure checks are. */
export interface GateGroups {
  readonly needsYou: ReadonlyArray<CheckWords>;
  readonly toRunSeveral: ReadonlyArray<CheckWords>;
  readonly inPlace: ReadonlyArray<CheckWords>;
}

export const gateGroups = (
  items: ReadonlyArray<MultiModeGateItem>,
  tenancy: Tenancy,
): GateGroups => {
  const checks = items.map(gateCheck);
  const missing = checks.filter((check) => !check.inPlace);
  const inPlace = checks.filter((check) => check.inPlace);
  return tenancy === "multi"
    ? { needsYou: missing, toRunSeveral: [], inPlace }
    : { needsYou: [], toRunSeveral: missing, inPlace };
};

export const runSeveralLine = (count: number): string =>
  `Before this server could run several organizations, ${counted(count, "thing", "things")} would have to change.`;

export const gateInPlaceLine = (inPlace: number, total: number): string =>
  inPlace === total
    ? `All ${total} things Mend needs to run several organizations are in place.`
    : inPlace === 1
      ? "One other item is in place."
      : `${inPlace} other items are in place.`;

export interface OrganizationCounts {
  readonly memberCount: number;
  readonly ownerCount: number;
}

/** "4 members, 2 owners"; an ownerless organization says so, as `mend operator organizations` does. */
export const organizationCounts = (summary: OrganizationCounts): string =>
  `${plural(summary.memberCount, "member", "members")}, ${
    summary.ownerCount === 0 ? "no owner" : plural(summary.ownerCount, "owner", "owners")
  }`;

/** "Created 3 Mar 2026". */
export const createdLine = (createdAt: Date): string =>
  `Created ${createdAt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;

/**
 * Who may create an organization (`MEND_ORGANIZATION_CREATION`), on a server with several. The
 * server doesn't report the value on its own: for an operator signed in with their own sign-in,
 * `organization.current`'s `canCreateOrganizations` is exactly whether it is `anyone`.
 */
export const creationWords = (
  canCreateOrganizations: boolean,
): { readonly word: string; readonly means: string } =>
  canCreateOrganizations
    ? { word: "Anyone signed in", means: "Anyone signed in can create an organization and own it." }
    : { word: "Only operators", means: "Only an operator creates organizations." };

// ---------------------------------------------------------------------------------------------
// This server

export interface ObservedAddress {
  readonly originScheme: "http" | "https";
  readonly originOnMachine: boolean;
  readonly arrivedVia: "direct" | "trusted-proxy";
}

/**
 * The sentence under the address: how Mend serves it (the scheme of `APP_URL`) and how this request
 * reached the server. The address itself is the browser's: the server doesn't send it.
 */
export const addressSentence = (address: ObservedAddress): string => {
  const scheme = address.originScheme === "https" ? "HTTPS" : "plain HTTP";
  const via =
    address.arrivedVia === "trusted-proxy"
      ? "through a proxy this server trusts"
      : address.originOnMachine
        ? "at an address on this machine"
        : "straight to this server";
  return `Served over ${scheme}, ${via}.`;
};

export interface HealthFacts {
  readonly version: string;
  readonly deploymentMode: Deployment;
  readonly sessionChannel: {
    readonly mode: "unix-socket" | "network";
    readonly endpoint: string | null;
  };
}

/** Where the server runs, from `/health`'s deployment mode. */
export const deploymentLine = (health: HealthFacts, hostname: string | null): string =>
  health.deploymentMode === "kubernetes"
    ? "Kubernetes"
    : hostname === null
      ? "One machine, with Docker"
      : `One machine, ${hostname}, with Docker`;

/** How workspaces reach their session. */
export const sessionChannelWords = (channel: HealthFacts["sessionChannel"]): Words =>
  channel.mode === "unix-socket"
    ? ["A socket per session, on this machine"]
    : channel.endpoint === null
      ? ["Over the network"]
      : w`Over the network, at ${code(channel.endpoint)}`;

// ---------------------------------------------------------------------------------------------
// Sealant

export type SealantStatus = "connected" | "unauthorized" | "mismatched" | "unreachable";

export interface SealantConnectionFacts {
  readonly status: SealantStatus;
  readonly baseUrl: string;
  readonly detail: string | null;
  readonly checkedAt: Date;
}

/** Sealant connected: a status word beside the row, a sentence under it. */
export const sealantConnected = (connection: SealantConnectionFacts, now: Date): string =>
  `Sealant runs every workspace. Mend reached it ${ago(connection.checkedAt, now)}.`;

/** Something that needs the operator, as "Needs you" lists it. */
export interface NeedsYouWords {
  readonly title: string;
  /** A status word beside the title (Unreachable, Key refused), when there is one. */
  readonly word: string | null;
  readonly saw: Words;
  /** What Mend asked and what came back, when that helps find the cause. */
  readonly asked: Words | null;
  readonly fix: Words | null;
  /** The check the item carries beside it, when Mend can look again from the page. */
  readonly recheck: "sealant" | "boat-key" | null;
}

/**
 * Sealant not connected, as "Needs you" says it; null while it is. Never shows the service key: a refused key says
 * Sealant refused it, nothing more.
 */
export const sealantNeedsYou = (
  connection: SealantConnectionFacts,
  now: Date,
  deployment: Deployment | null,
): NeedsYouWords | null => {
  const when = ago(connection.checkedAt, now);
  const asked =
    connection.detail === null
      ? w`Mend asked at ${code(connection.baseUrl)}.`
      : w`Mend asked at ${code(connection.baseUrl)} and saw ${code(connection.detail)}.`;
  const helm = deployment === "kubernetes";
  const noSession = "Sealant runs every workspace, so no new session can start.";
  switch (connection.status) {
    case "connected":
      return null;
    case "unreachable":
      return {
        title: "Sealant can't be reached",
        recheck: "sealant",
        word: "Unreachable",
        saw: [`Mend couldn't reach Sealant when it checked, ${when}. ${noSession}`],
        asked,
        fix: helm
          ? ["Read the Sealant pod's logs in your cluster to see what it said."]
          : w`On the server, ${code("mend server logs --tail 200")} shows what Sealant said, and ${code("mend server restart")} starts it again.`,
      };
    case "unauthorized":
      return {
        title: "Sealant refused this server's key",
        recheck: "sealant",
        word: "Key refused",
        saw: [`Sealant refused this server's service key when Mend checked, ${when}. ${noSession}`],
        asked: w`Mend asked at ${code(connection.baseUrl)}.`,
        fix: helm
          ? [
              "Give the server a new Sealant service key in your Helm values, and upgrade the release.",
            ]
          : w`Give the server a new key with ${code("mend server setup")}.`,
      };
    case "mismatched":
      return {
        title: "Something else answers at Sealant's address",
        recheck: "sealant",
        word: "Not Sealant",
        saw: [
          `Something answered at Sealant's address when Mend checked, ${when}, but not with the Sealant API Mend speaks.`,
        ],
        asked,
        fix: helm
          ? ["Point the server at Sealant in your Helm values, and upgrade the release."]
          : w`Point the server at Sealant with ${code("mend server setup")}.`,
      };
  }
};

// ---------------------------------------------------------------------------------------------
// Where sessions run

export type Runtime = "docker" | "boat";

export const RUNTIMES: ReadonlyArray<Runtime> = ["docker", "boat"];

export const RUNTIME_NAMES: Readonly<Record<Runtime, string>> = { docker: "Docker", boat: "Boat" };

/** Where a runtime's workspaces run. */
export const RUNTIME_PLACES: Readonly<Record<Runtime, string>> = {
  docker: "Workspaces run as containers on this server.",
  boat: "Workspaces run as virtual machines on Boat, through Sealant.",
};

/** Whether the server offers a runtime, and whether new organizations start on it. */
export const runtimeOffer = (
  runtime: Runtime,
  offer: { readonly offered: ReadonlyArray<Runtime>; readonly default: Runtime },
): { readonly word: string; readonly startsHere: boolean } =>
  offer.offered.includes(runtime)
    ? { word: "Offered", startsHere: offer.default === runtime }
    : { word: "Not offered", startsHere: false };

const REPLACE_SERVER_KEY_TEXT =
  "Make a new key in Boat, then give it to the server with mend server setup --boat-api-key-stdin.";

const REPLACE_SERVER_KEY = w`Make a new key in Boat, then give it to the server with ${code("mend server setup --boat-api-key-stdin")}.`;

const NO_WORKER_FIX = w`On the server, ${code("mend server logs --tail 200")} shows what the worker said, and ${code("mend server restart")} starts it again.`;

/**
 * What the server saw about Boat, split for the page: sentences for the Boat row, and anything
 * that needs the operator for "Needs you" (the row then points there).
 */
export interface BoatWords {
  readonly sentences: ReadonlyArray<Words>;
  readonly needsYou: ReadonlyArray<NeedsYouWords>;
}

const PURPOSES = { sessions: "reach this server", "saved-work": "save their work" } as const;

const boatAddressWords = (facts: ServerBoatFacts, now: Date): BoatWords => {
  const answered = facts.addresses.filter((address) => address.answer.answered);
  const silent = facts.addresses.flatMap((address) =>
    address.answer.answered ? [] : [{ ...address, why: address.answer.detail }],
  );
  const sessions = answered.find((address) => address.purpose === "sessions");
  const saved = answered.find((address) => address.purpose === "saved-work");
  const latest = answered.map((address) => address.observedAt).toSorted((a, b) => +b - +a)[0];
  const where =
    sessions !== undefined && saved !== undefined
      ? w`Boat workspaces reach this server at ${code(sessions.url)} and save their work to ${code(saved.url)}. Both answered when this server asked, ${latest === undefined ? "" : ago(latest, now)}.`
      : answered.length === 1 && answered[0] !== undefined
        ? w`Boat workspaces ${PURPOSES[answered[0].purpose]} at ${code(answered[0].url)}. It answered when this server asked, ${ago(answered[0].observedAt, now)}.`
        : null;
  return {
    sentences: [
      ...(where === null ? [] : [where]),
      ...(silent.length === 0 ? [] : [["What to do about Boat's addresses is under Needs you."]]),
    ],
    needsYou: silent.map((address) => ({
      title: "Boat can't reach this server",
      word: null,
      recheck: null,
      saw: w`${code(address.url)}, where Boat workspaces ${PURPOSES[address.purpose]}, didn't answer when this server asked, ${ago(address.observedAt, now)}.`,
      asked: w`Mend saw ${code(address.why)}.`,
      fix: w`Forward ${code(address.url)} to this server with a Tailscale Funnel or your own TLS proxy. Boat workspaces reach it, and a Boat session can't start or keep its work without it.`,
    })),
  };
};

const walletOf = (report: Extract<ServerBoatFacts["serverKey"], { state: "held" }>["report"]) => {
  if (report === null || !report.wallet.observed) return null;
  return report.wallet.kind === "organization"
    ? `the ${report.wallet.organizationName ?? "Boat organization's"} wallet`
    : "a personal wallet";
};

const boatKeyWords = (facts: ServerBoatFacts, now: Date): BoatWords => {
  const key = facts.serverKey;
  switch (key.state) {
    case "none":
      return {
        sentences: [
          [
            "This server has no Boat key of its own. Each organization's Boat sessions run on the key its owner connects.",
          ],
        ],
        needsYou: [],
      };
    case "unread":
      return {
        sentences: [[`Mend couldn't read this server's Boat key: ${key.reason}.`]],
        needsYou: [],
      };
    case "held": {
      const report = key.report;
      if (report === null) {
        return {
          sentences: [
            [
              "This server has a Boat key of its own. Sealant hasn't checked it with Boat yet. It does when the server starts and once a day.",
            ],
          ],
          needsYou: [],
        };
      }
      const checked = whenChecked(report.observedAt, now);
      if (reportRefusal(report) !== null) {
        return {
          sentences: [
            [
              "Boat refused this server's own key when Sealant last checked it. What to do is under Needs you.",
            ],
          ],
          needsYou: [
            {
              title: "Boat refused this server's key",
              recheck: "boat-key",
              word: "Key refused",
              saw: [
                `Sealant checked this server's own Boat key ${checked}, and Boat refused it. Boat sessions that use this key can't start.`,
              ],
              asked: null,
              fix: REPLACE_SERVER_KEY,
            },
          ],
        };
      }
      const line: StatusLine = boatKeyStatusLine({
        label: "boat key",
        holder: "server",
        report,
        replace: REPLACE_SERVER_KEY_TEXT,
        now,
      });
      const wallet = walletOf(report);
      const canStart = report.start.observed && report.start.canStart;
      const what = [
        ...(wallet === null ? [] : [`it bills ${wallet}`]),
        ...(canStart ? ["can start a VM"] : []),
      ].join(" and ");
      const held = `This server has a Boat key of its own. Sealant checked it with Boat ${checked}${what === "" ? "." : `: ${what}.`}`;
      if (line.state === "failed") {
        return {
          sentences: [[held, " What to do is under Needs you."]],
          needsYou: [
            {
              title: "This server's Boat key",
              word: null,
              recheck: "boat-key",
              saw: [`Sealant checked this server's own Boat key with Boat ${checked}.`],
              asked: null,
              fix: line.fix === null ? null : [line.fix],
            },
          ],
        };
      }
      return {
        sentences: [[held], ...(line.fix === null ? [] : [[line.fix]])],
        needsYou: [],
      };
    }
  }
};

const boatLaunchWords = (facts: ServerBoatFacts): BoatWords => {
  const launch = facts.launch;
  switch (launch.state) {
    case "listed":
      return launch.resourceGateway
        ? {
            sentences: [
              w`Sealant can launch Boat workspaces, and they can reach project resources such as ${code("@db")}.`,
            ],
            needsYou: [],
          }
        : {
            sentences: [
              [
                "Sealant can launch Boat workspaces. What to do about project resources is under Needs you.",
              ],
            ],
            needsYou: [
              {
                title: "Boat workspaces can't reach project resources",
                word: null,
                recheck: null,
                saw: w`The worker that launches Boat runs no resource gateway, so a Boat session in a project with resources (${code("@db")}) is refused.`,
                asked: null,
                fix: NO_WORKER_FIX,
              },
            ],
          };
    case "not-listed":
      return facts.serverKey.state === "none" && facts.storedKeys === 0
        ? {
            sentences: [
              w`Sealant doesn't list Boat yet: no Boat key is connected to launch with. An owner connects their organization's key on its Boat page, or with ${code("mend boat connect")}.`,
            ],
            needsYou: [],
          }
        : {
            sentences: [["Sealant can't launch Boat workspaces. What to do is under Needs you."]],
            needsYou: [
              {
                title: "Sealant can't launch Boat workspaces",
                word: null,
                recheck: null,
                saw: [
                  "No worker has told Sealant it launches Boat VMs, so Boat sessions are refused.",
                ],
                asked: null,
                fix: NO_WORKER_FIX,
              },
            ],
          };
    case "unread":
      return {
        sentences: [
          [`Mend couldn't read whether Sealant can launch Boat workspaces: ${launch.reason}.`],
        ],
        needsYou: [],
      };
  }
};

/** Everything the server saw about Boat, in the order a person reads it. */
export const boatWords = (facts: ServerBoatFacts, now: Date): BoatWords => {
  const parts = [boatAddressWords(facts, now), boatKeyWords(facts, now), boatLaunchWords(facts)];
  return {
    sentences: parts.flatMap((part) => part.sentences),
    needsYou: parts.flatMap((part) => part.needsYou),
  };
};

// ---------------------------------------------------------------------------------------------
// The starting workspace image (image-instance-default, read-only)

export type ImageFacts =
  | {
      readonly mode: "family";
      readonly os: string;
      readonly shell: string;
      readonly packages: ReadonlyArray<string>;
      readonly services: { readonly docker: boolean };
      readonly screen: boolean;
    }
  | {
      readonly mode: "custom";
      readonly baseImage: string;
      readonly packages: ReadonlyArray<string>;
      readonly setupCommands: ReadonlyArray<string>;
      readonly services: { readonly docker: boolean };
    };

const OS_NAMES: Readonly<Record<string, string>> = {
  arch: "Arch",
  fedora: "Fedora",
  ubuntu: "Ubuntu",
  nix: "Nix",
};

/** The image's name, the row's label: "Ubuntu, with zsh", or the custom image it builds from. */
export const imageName = (image: ImageFacts): string =>
  image.mode === "family"
    ? `${OS_NAMES[image.os] ?? image.os}, with ${image.shell}`
    : image.baseImage;

/** What the image adds to a workspace beyond its packages. */
export const imageExtras = (image: ImageFacts): string => {
  const docker = image.services.docker ? "Docker inside workspaces" : "No Docker inside workspaces";
  if (image.mode === "custom") return `${docker}.`;
  return `${docker}, and ${image.screen ? "a screen agents can drive" : "no screen"}.`;
};

/** The closed line over the image's packages or setup commands. */
export const packagesLine = (count: number): string => plural(count, "package", "packages");

export const setupCommandsLine = (count: number): string =>
  plural(count, "setup command", "setup commands");
