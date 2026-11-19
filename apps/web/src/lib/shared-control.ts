import { TRPCClientError } from "@trpc/client";

import { failureWords } from "./refusal.ts";

/**
 * Shared control of a session, as the new web app shows it (docs/adr/0026, decision 7; Doop page 6
 * "Working with others"): it goes to the person who asked, not to everyone who can see the
 * project. Someone who sees another person's session asks; the owner turns it on for them or
 * dismisses the ask; the owner, or an organization owner, turns it off again. The server says who
 * may do what (`acts`) and refuses what it no longer allows; nothing here guesses.
 *
 * The switch for everyone that older clients have (`everyoneSince`) still counts: while it is on,
 * everyone who can see the project steers, and turning it off ends every grant. The new app shows
 * it and turns it off, but offers no way to turn it on: the frames share with one person at a time.
 *
 * Pure, so each state's words are testable.
 */

/** One person who asked for shared control or holds it. */
export interface SharedControlPersonView {
  readonly userId: string;
  readonly state: "asked" | "granted";
  readonly askedAt: Date;
  readonly grantedAt: Date | null;
}

/** The server's read of a session's shared control (`sessions.sharedControl`). */
export interface SharedControlView {
  readonly ownerUserId: string | null;
  readonly everyoneSince: Date | null;
  readonly granted: ReadonlyArray<SharedControlPersonView>;
  /** Every open ask for the owner; only the viewer's own for anyone else. */
  readonly asked: ReadonlyArray<SharedControlPersonView>;
  readonly steer: boolean;
  readonly acts: {
    readonly ask: boolean;
    readonly withdraw: boolean;
    readonly decide: boolean;
    readonly takeBack: boolean;
  };
  readonly turnsOnSendersLogin: boolean;
}

/** Names a person by user id; null when the roster doesn't know them (yet). */
export type NameOf = (userId: string) => string | null;

/** What the people a sentence names are called, never blank. */
const nameOrSomeone = (nameOf: NameOf, userId: string | null): string =>
  (userId === null ? null : nameOf(userId)) ?? "Someone";

/** The first word of a name, as the frames shorten it in a sentence ("Ask Grace for…"). */
export const firstName = (name: string): string => name.split(/\s+/)[0] ?? name;

/** "Ada Lovelace", "Ada Lovelace and Linus Pauling", "Ada, Linus and Mae". */
export const nameList = (names: ReadonlyArray<string>): string => {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
};

// ─── The band over the conversation ─────────────────────────────────────────

/** The band's icon: what the frames draw beside each state. */
export type BandIcon = "watching" | "asked" | "hand" | "shared";

/** One action in a band: its words, and what it does. */
export type BandAct =
  | { readonly kind: "ask" }
  | { readonly kind: "withdraw" }
  | { readonly kind: "grant"; readonly userId: string }
  | { readonly kind: "decline"; readonly userId: string }
  | { readonly kind: "turn-off" };

export interface BandButton {
  readonly label: string;
  /** The shorter words a phone's stacked band uses. */
  readonly phoneLabel: string;
  readonly pendingLabel: string;
  readonly primary: boolean;
  readonly act: BandAct;
}

/** A band over a session's conversation: what is so about its shared control, and what to do. */
export interface Band {
  readonly key: string;
  readonly icon: BandIcon;
  readonly title: string;
  readonly body: string;
  /** The phone's shorter body, where the frames shorten it. */
  readonly phoneBody: string;
  readonly buttons: ReadonlyArray<BandButton>;
}

interface BandContext {
  readonly viewerId: string;
  readonly nameOf: NameOf;
  /** The session's agent ("Claude Code"). */
  readonly agent: string;
  readonly projectName: string;
  /** Who started the session as its owner, when the session says. */
  readonly ownerUserId: string | null;
  /** When the viewer asked, as the band says it: "10:52". */
  readonly timeOf: (at: Date) => string;
}

/** What the people a grant reaches may do, in the frames' words. */
const mayDo = (agent: string): string =>
  `send messages, answer ${agent}'s questions and approve commands`;

/** Whose login a steered message runs on, as the band says it to the person who steers. */
const yourLogin = (view: SharedControlView, agent: string, owner: string): string =>
  view.turnsOnSendersLogin
    ? `They run on your own ${agent} login.`
    : `They run on ${firstName(owner)}'s logins, since this workspace shares one home.`;

/**
 * The bands a session shows the viewer about its shared control, in order: for its owner, each
 * open ask (oldest first), then who holds it; for anyone else, whose session it is and where
 * their ask stands. A session that is the viewer's own, with nothing asked or shared, shows none.
 */
export const sharedControlBands = (view: SharedControlView, context: BandContext): Band[] => {
  const { viewerId, nameOf, agent, projectName } = context;
  const ownerId = view.ownerUserId ?? context.ownerUserId;
  const owner = nameOrSomeone(nameOf, ownerId);
  const isOwner = ownerId !== null && ownerId === viewerId;
  const bands: Band[] = [];

  if (isOwner && view.acts.decide)
    for (const ask of view.asked) {
      const asker = nameOrSomeone(nameOf, ask.userId);
      const first = firstName(asker);
      bands.push({
        key: `ask:${ask.userId}`,
        icon: "hand",
        title: `${asker} asked for shared control.`,
        body: `${first} wants to send messages in this session. Turning it on lets ${first} ${mayDo(agent)}. You can turn it off at any time.`,
        phoneBody: `Turning it on lets ${first} send messages here. You can turn it off at any time.`,
        buttons: [
          {
            label: "Turn on shared control…",
            phoneLabel: "Turn on…",
            pendingLabel: "Turn on shared control…",
            primary: true,
            act: { kind: "grant", userId: ask.userId },
          },
          {
            label: "Dismiss request",
            phoneLabel: "Dismiss",
            pendingLabel: "Dismissing…",
            primary: false,
            act: { kind: "decline", userId: ask.userId },
          },
        ],
      });
    }

  const holders = view.granted.map((person) => nameOrSomeone(nameOf, person.userId));
  const holdsAny = view.everyoneSince !== null || holders.length > 0;
  const turnOff: BandButton = {
    label: "Turn off shared control",
    phoneLabel: "Turn off shared control",
    pendingLabel: "Turning off…",
    primary: false,
    act: { kind: "turn-off" },
  };

  // The owner's, or an organization owner's, view of who steers besides the owner.
  if ((isOwner || (view.acts.takeBack && !view.steer)) && holdsAny) {
    const turnsOn =
      view.everyoneSince === null && holders.length === 1
        ? `${firstName(holders[0] ?? "")}'s own ${agent} login`
        : `each sender's own ${agent} login`;
    const runs = view.turnsOnSendersLogin
      ? `They run on ${turnsOn}.`
      : isOwner
        ? "They run on your logins, since this workspace shares one home."
        : `They run on ${firstName(owner)}'s logins, since this workspace shares one home.`;
    const who =
      view.everyoneSince !== null
        ? `Everyone who can see ${projectName === "" ? "this project" : projectName}`
        : nameList(holders);
    bands.push({
      key: "shared",
      icon: "shared",
      title: isOwner ? "Shared control is on." : `${owner} shares control of this session.`,
      body:
        view.everyoneSince !== null
          ? `${who} can ${mayDo(agent)}. ${runs}`
          : `${who} can ${mayDo(agent)}. ${runs} Everyone else can still only read this session.`,
      phoneBody:
        view.everyoneSince !== null
          ? `${who} can send messages here. ${runs}`
          : `${who} can send messages here. ${runs} Everyone else can still only read it.`,
      buttons: view.acts.takeBack ? [turnOff] : [],
    });
    return bands;
  }
  if (isOwner) return bands;

  // Someone else's session.
  const ownerFirst = firstName(owner);
  if (view.steer) {
    const how =
      view.everyoneSince !== null && !view.granted.some((person) => person.userId === viewerId)
        ? `${ownerFirst} turned on shared control for everyone who can see ${projectName === "" ? "this project" : projectName}`
        : `${ownerFirst} turned on shared control`;
    const body = `${how}, so you can send messages. ${yourLogin(view, agent, owner)}`;
    bands.push({
      key: "steering",
      icon: "shared",
      title: `This is ${owner}'s session.`,
      body,
      phoneBody: body,
      buttons: [],
    });
    return bands;
  }
  const own = view.asked.find((person) => person.userId === viewerId);
  if (own !== undefined) {
    bands.push({
      key: "asked",
      icon: "asked",
      title: `You asked ${owner} for shared control at ${context.timeOf(own.askedAt)}.`,
      body: `It shows in this session and in ${ownerFirst}'s inbox. When ${ownerFirst} turns it on, you can send messages here.`,
      phoneBody: `When ${ownerFirst} turns it on, you can send messages here.`,
      buttons: view.acts.withdraw
        ? [
            {
              label: "Cancel request",
              phoneLabel: "Cancel request",
              pendingLabel: "Cancelling…",
              primary: false,
              act: { kind: "withdraw" },
            },
          ]
        : [],
    });
    return bands;
  }
  bands.push({
    key: "watching",
    icon: "watching",
    title: `This is ${owner}'s session.`,
    body: view.acts.ask
      ? `You can read the conversation and review the change. Ask ${ownerFirst} for shared control to send messages too.`
      : "You can read the conversation and review the change.",
    phoneBody: view.acts.ask
      ? `You can read it and review the change. Ask ${ownerFirst} for shared control to send messages too.`
      : "You can read it and review the change.",
    buttons: view.acts.ask
      ? [
          {
            label: "Ask for shared control",
            phoneLabel: "Ask for shared control",
            pendingLabel: "Asking…",
            primary: false,
            act: { kind: "ask" },
          },
        ]
      : [],
  });
  return bands;
};

// ─── Turning it on for one person ───────────────────────────────────────────

/** A row of the Turn on dialog: a heading and what it says. */
export interface GrantRow {
  readonly icon: "people" | "message" | "lock" | "toggle";
  readonly title: string;
  readonly body: string;
}

/**
 * What the Turn on shared control dialog says (Doop "Shared control · turn on dialog"): who can
 * send messages once it is on, what the asker can do, what stays the owner's, and how to turn it
 * off. The frames name the project's other people; the server says only who holds it, so the
 * dialog says everyone else reads.
 */
export const grantDialog = (
  view: SharedControlView,
  context: {
    readonly askerId: string;
    readonly nameOf: NameOf;
    readonly agent: string;
    readonly projectName: string;
    readonly sessionTitle: string;
  },
): { readonly title: string; readonly description: string; readonly rows: GrantRow[] } => {
  const asker = nameOrSomeone(context.nameOf, context.askerId);
  const first = firstName(asker);
  const others = view.granted
    .filter((person) => person.userId !== context.askerId)
    .map((person) => nameOrSomeone(context.nameOf, person.userId));
  const project = context.projectName === "" ? "this project" : context.projectName;
  return {
    title: `Turn on shared control for ${asker}?`,
    description: `${first} asked to send messages in ${context.sessionTitle}.`,
    rows: [
      {
        icon: "people",
        title: "Who can send messages",
        body: `${nameList([asker, ...others, "you"])}. Everyone else who can open ${project} can only read this session.`,
      },
      {
        icon: "message",
        title: `What ${first} can do`,
        body: view.turnsOnSendersLogin
          ? `Send messages, answer ${context.agent}'s questions, approve or deny commands and stop a turn. Mend shows ${first}'s name on each message ${first} sends and runs it on ${first}'s own ${context.agent} login.`
          : `Send messages, answer ${context.agent}'s questions, approve or deny commands and stop a turn. Mend shows ${first}'s name on each message ${first} sends. This workspace shares one home, so they run on your logins.`,
      },
      {
        icon: "lock",
        title: "What stays yours",
        body: `Only you can stop the session, land the change and turn shared control off. ${first} can watch the terminal but can't type in it.`,
      },
      {
        icon: "toggle",
        title: "Turning it off",
        body: "Use Turn off shared control in the notice at the top of the session, or in its … menu. Messages already sent stay in the conversation.",
      },
    ],
  };
};

/**
 * What Turn off shared control does: the switch for everyone off when it is on (which ends every
 * grant too), else each person's grant taken back.
 */
export type TurnOffStep =
  | { readonly kind: "everyone-off" }
  | { readonly kind: "take-back"; readonly userId: string };

export const turnOffSteps = (view: SharedControlView): TurnOffStep[] =>
  view.everyoneSince !== null
    ? [{ kind: "everyone-off" }]
    : view.granted.map((person) => ({ kind: "take-back", userId: person.userId }));

/** The "…" menu's items to turn it off: one, or one per person when several hold it. */
export const turnOffItems = (
  view: SharedControlView,
  nameOf: NameOf,
): Array<{ readonly label: string; readonly steps: TurnOffStep[] }> => {
  if (!view.acts.takeBack) return [];
  if (view.everyoneSince !== null || view.granted.length <= 1) {
    const steps = turnOffSteps(view);
    return steps.length === 0 ? [] : [{ label: "Turn off shared control", steps }];
  }
  return view.granted.map((person) => ({
    label: `Turn off shared control for ${nameOrSomeone(nameOf, person.userId)}`,
    steps: [{ kind: "take-back", userId: person.userId }],
  }));
};

// ─── Refusals ───────────────────────────────────────────────────────────────

/** The shared control facts beside a refusal (`data.sharedControl`, server/api/errors.ts). */
const factsOf = (
  cause: unknown,
): {
  readonly reason: string | null;
  readonly login: { readonly provider: string; readonly state: string } | null;
} | null => {
  if (!(cause instanceof TRPCClientError)) return null;
  const data: unknown = cause.data;
  if (typeof data !== "object" || data === null || !("sharedControl" in data)) return null;
  const facts: unknown = data.sharedControl;
  if (typeof facts !== "object" || facts === null) return null;
  const reason = "reason" in facts && typeof facts.reason === "string" ? facts.reason : null;
  const login =
    "login" in facts &&
    typeof facts.login === "object" &&
    facts.login !== null &&
    "provider" in facts.login &&
    typeof facts.login.provider === "string" &&
    "state" in facts.login &&
    typeof facts.login.state === "string"
      ? { provider: facts.login.provider, state: facts.login.state }
      : null;
  return { reason, login };
};

/** Why the server refused a step of shared control (`SharedControlRefused.reason`), or null. */
export const refusalReasonOf = (cause: unknown): string | null => factsOf(cause)?.reason ?? null;

/** A sender's own login, as the server refused their message for it. */
export interface LoginRefusal {
  readonly provider: string;
  readonly state: "missing" | "invalid" | "unchosen";
}

const LOGIN_STATES: ReadonlySet<string> = new Set(["missing", "invalid", "unchosen"]);

const isLoginState = (state: string): state is LoginRefusal["state"] => LOGIN_STATES.has(state);

/** The sender's login a refused message names (`SessionNotSteerable.login`), or null. */
export const loginRefusalOf = (cause: unknown): LoginRefusal | null => {
  const login = factsOf(cause)?.login ?? null;
  if (login === null || !isLoginState(login.state)) return null;
  return { provider: login.provider, state: login.state };
};

/** What a refused step says, in words for a person; the server's own words otherwise. */
export const stepRefusalWords = (
  cause: unknown,
  nameOf: NameOf,
  askerId: string | null,
): string => {
  const asker = askerId === null ? null : nameOf(askerId);
  switch (refusalReasonOf(cause)) {
    case "not-asked":
      return `${asker === null ? "The request" : `${firstName(asker)}'s request`} is no longer open: it was cancelled or already answered.`;
    case "not-granted":
      return `${asker ?? "They"} no longer ${asker === null ? "have" : "has"} shared control.`;
    case "ended":
      return "The session has ended, so shared control no longer applies.";
    case "steers":
      return "You can already send messages in this session.";
    case "owner":
      return "This is your session, so you already send its messages.";
    case "opencode":
      return "opencode sessions are one person's. Start your own session in this worktree instead.";
    default:
      return failureWords(cause, "Mend didn't answer. Try again.");
  }
};

// ─── The conversation's markers ─────────────────────────────────────────────

/** A shared control event from the session's control log (`sessions.controlEvents`). */
export interface ControlEventView {
  readonly id: string;
  readonly actorUserId: string;
  readonly kind: string;
  readonly refId: string | null;
  readonly createdAt: Date;
}

export interface ControlMarker {
  readonly key: string;
  readonly at: string;
  readonly icon: "hand" | "shared" | "off";
  readonly label: string;
}

/**
 * The control log's shared control events as lines in the conversation (Doop "Shared control ·
 * Grace sees Ada's message"): "Ada Lovelace asked for shared control", "You turned on shared
 * control for Ada Lovelace". Each names people as the viewer reads them.
 */
export const controlMarkers = (
  events: ReadonlyArray<ControlEventView>,
  context: {
    readonly viewerId: string;
    readonly nameOf: NameOf;
    readonly ownerUserId: string | null;
  },
): ControlMarker[] => {
  const { viewerId, nameOf } = context;
  const who = (userId: string) => (userId === viewerId ? "You" : nameOrSomeone(nameOf, userId));
  const whom = (userId: string | null) =>
    userId === null ? "someone" : userId === viewerId ? "you" : nameOrSomeone(nameOf, userId);
  const owner = context.ownerUserId;
  const markers: ControlMarker[] = [];
  for (const event of events) {
    const actor = who(event.actorUserId);
    const base = { key: `control:${event.id}`, at: event.createdAt.toISOString() };
    switch (event.kind) {
      case "shared-control-ask":
        markers.push({
          ...base,
          icon: "hand",
          label:
            event.actorUserId === viewerId && owner !== null && owner !== viewerId
              ? `You asked ${nameOrSomeone(nameOf, owner)} for shared control`
              : `${actor} asked for shared control`,
        });
        break;
      case "shared-control-withdraw":
        markers.push({
          ...base,
          icon: "off",
          label: `${actor} cancelled ${event.actorUserId === viewerId ? "your" : "the"} request for shared control`,
        });
        break;
      case "shared-control-grant":
        markers.push({
          ...base,
          icon: "shared",
          label: `${actor} turned on shared control for ${whom(event.refId)}`,
        });
        break;
      case "shared-control-decline":
        markers.push({
          ...base,
          icon: "off",
          label: `${actor} dismissed ${event.refId === viewerId ? "your" : `${whom(event.refId)}'s`} request for shared control`,
        });
        break;
      case "shared-control-take-back":
        markers.push({
          ...base,
          icon: "off",
          label: `${actor} turned off shared control for ${whom(event.refId)}`,
        });
        break;
      case "shared-control-on":
        markers.push({
          ...base,
          icon: "shared",
          label: `${actor} turned on shared control for everyone who can see the project`,
        });
        break;
      case "shared-control-off":
        markers.push({ ...base, icon: "off", label: `${actor} turned off shared control` });
        break;
      default:
        break;
    }
  }
  return markers.toSorted((a, b) => a.at.localeCompare(b.at));
};

/**
 * Markers laid between a conversation's entries by time: each before the first entry that came
 * after it. One older than every entry held belongs to an earlier window, unless the entries reach
 * the start.
 */
export const withMarkers = <Entry, Marker extends { readonly at: string }>(
  entries: ReadonlyArray<Entry>,
  atOf: (entry: Entry) => string,
  markers: ReadonlyArray<Marker>,
  fromStart: boolean,
): Array<
  | { readonly kind: "entry"; readonly entry: Entry }
  | { readonly kind: "marker"; readonly marker: Marker }
> => {
  const first = entries[0] === undefined ? undefined : atOf(entries[0]);
  const out: Array<
    | { readonly kind: "entry"; readonly entry: Entry }
    | { readonly kind: "marker"; readonly marker: Marker }
  > = [];
  let next = 0;
  const until = (before: string | null) => {
    while (next < markers.length) {
      const marker = markers[next];
      if (marker === undefined || (before !== null && marker.at >= before)) return;
      next += 1;
      if (!fromStart && first !== undefined && marker.at < first) continue;
      out.push({ kind: "marker", marker });
    }
  };
  for (const entry of entries) {
    until(atOf(entry));
    out.push({ kind: "entry", entry });
  }
  until(null);
  return out;
};

// ─── The sender's own login ─────────────────────────────────────────────────

/** The words of the band over a message refused for the sender's own login (Doop "Login expired"). */
export const loginBand = (
  refusal: LoginRefusal,
  context: { readonly agentName: string; readonly ownerName: string | null; readonly own: boolean },
): { readonly title: string; readonly body: string; readonly connect: boolean } => {
  const { agentName } = context;
  const where =
    context.own || context.ownerName === null
      ? "Messages you send run on your own login."
      : `Messages you send in ${firstName(context.ownerName)}'s session run on your own login.`;
  switch (refusal.state) {
    case "invalid":
      return {
        title: `Your ${agentName} login has expired, so your message wasn't sent.`,
        body: `${where} Connect ${agentName} again and Mend sends the message. It's still in the box below.`,
        connect: true,
      };
    case "missing":
      return {
        title: `You haven't connected ${agentName}, so your message wasn't sent.`,
        body: `${where} Connect ${agentName} and Mend sends the message. It's still in the box below.`,
        connect: true,
      };
    case "unchosen":
      return {
        title: `You haven't picked which ${agentName} login to use, so your message wasn't sent.`,
        body: `${where} Pick one in Settings, under Agent logins, then send the message again. It's still in the box below.`,
        connect: false,
      };
  }
};

/** A refusal kept beside the session's draft until the login works again, as stored. */
export interface LoginHold extends LoginRefusal {
  /** When the message was refused (ms): only a read of the logins after it can send it. */
  readonly at: number;
}

export const parseLoginHold = (raw: string): LoginHold | null => {
  if (raw === "") return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === "object" &&
      value !== null &&
      "provider" in value &&
      typeof value.provider === "string" &&
      "state" in value &&
      typeof value.state === "string" &&
      isLoginState(value.state) &&
      "at" in value &&
      typeof value.at === "number"
    )
      return { provider: value.provider, state: value.state, at: value.at };
    return null;
  } catch {
    return null;
  }
};

// ─── The inbox ──────────────────────────────────────────────────────────────

/** What an owner's inbox row says while people ask for shared control: "Ada asked for shared control". */
export const askersWords = (askers: ReadonlyArray<string | null>): string => {
  if (askers.length === 0) return "";
  if (askers.length > 1) return `${askers.length} people asked for shared control`;
  const name = askers[0] ?? null;
  return `${name === null ? "Someone" : firstName(name)} asked for shared control`;
};

/** The phone row's longer line: "Ada Lovelace asked for shared control". */
export const askersDetail = (askers: ReadonlyArray<string | null>): string => {
  if (askers.length === 0) return "";
  const named = askers.map((name) => name ?? "Someone");
  return `${nameList(named)} asked for shared control`;
};
