import { ConversationMarker } from "@mend/ui/components/conversation-marker";
import { PromptInput } from "@mend/ui/components/prompt-input";
import { Message, MessageContent, MessageHeader } from "@mend/ui/components/ui/message";
import { SidebarMenu, SidebarProvider } from "@mend/ui/components/ui/sidebar";
import { UserMessage } from "@mend/ui/components/user-message";
import { cn } from "@mend/ui/lib/utils";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { ChevronsUpDownIcon, FileDiffIcon, InfoIcon, PanelLeftIcon } from "lucide-react";
import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from "react";

import { useAdoptionAttempt } from "#/lib/adoptions";
import {
  type FitsNames,
  GROUP_WORDS,
  nestingCaption,
  nestingIntro,
  organizationLine,
  SAMPLE_BRANCH,
  SAMPLE_SESSION,
  SAMPLE_WORKTREE,
  sampleInboxView,
  sessionCaption,
  sidebarCaption,
  pictureProject,
  sidebarIntro,
} from "#/lib/how-mend-fits";
import type { FitsScreen } from "#/lib/how-mend-fits-screen";
import { useServerHost } from "#/lib/online";
import { signedInOptions } from "#/lib/sign-in";
import { useTRPC } from "#/lib/trpc";
import { useViewer } from "#/lib/use-viewer";

import { AppSidebar, SIDEBAR_RAIL_WIDTH, SIDEBAR_WIDTH, SidebarRow } from "./app-sidebar.tsx";
import { NoSearch } from "./command-palette.tsx";
import { OrganizationMark } from "./organization-menu.tsx";
import { PhoneInbox } from "./phone-inbox.tsx";
import { TabLine } from "./project/project-frame.tsx";
import { Group, Mono, Row } from "./workspace/details-view.tsx";
import { PhoneHeader } from "./workspace/phone-header.tsx";
import { TileTab } from "./workspace/tile-tab.tsx";
import { Tile } from "./workspace/tile.tsx";
import { WorkspaceHeader } from "./workspace/workspace-header.tsx";

/**
 * The three screens of How Mend fits together (SLNT-1203; Doop "How Mend fits together", "Inside a
 * session", "The sidebar" and their phone frames), shared by setup's last step and the dialog the
 * account menu opens. Each screen is its words beside pictures of the app.
 *
 * The pictures are the app's own components drawn with sample data (`lib/how-mend-fits.ts`) and
 * scaled down to fit: the sidebar is `AppSidebar` itself over a sample inbox, a session is the
 * real header, tiles and tabs. So a picture changes when the component does. They are inert and
 * hidden from screen readers: nothing in them can be pressed, and the words beside each picture,
 * and its caption, say what it shows.
 */

/**
 * What the screens name, for the signed-in person: their organization and whether they own it,
 * their name, this server, and the project the pictures show (the clone this browser started, the
 * newest project they can see, or the sample).
 */
export const useFitsNames = (): FitsNames => {
  const trpc = useTRPC();
  const signedIn = useSuspenseQuery(signedInOptions(trpc)).data;
  const { organizationName, account } = useViewer();
  const host = useServerHost();
  const cloning = useAdoptionAttempt(signedIn.userId);
  const projects = useQuery(trpc.projects.list.queryOptions());
  // Until the list answers, or if it can't, the pictures use the clone or the sample.
  const project = pictureProject(
    cloning?.name ?? null,
    projects.isPending || projects.isError ? [] : projects.data,
  );
  return {
    host,
    organization: organizationName,
    owner: signedIn.role === "owner",
    person: account.name,
    email: account.email,
    project: project.name,
    ownProject: project.own,
  };
};

/** The words of a screen and how wide they may run: the setup column, or the narrower dialog. */
interface ScreenProps {
  readonly names: FitsNames;
  readonly phone: boolean;
  readonly place: "step" | "dialog";
}

export function FitsScreenBody({
  screen,
  ...props
}: ScreenProps & { readonly screen: FitsScreen }) {
  if (screen === 1) return <NestingScreen {...props} />;
  if (screen === 2) return <SessionScreen {...props} />;
  return <SidebarScreen {...props} />;
}

const LEAD = "text-prose text-pretty text-foreground max-lg:text-sm";
const CAPTION = "text-row text-pretty text-muted-foreground";

/** The width of a box, followed as it changes; 0 until it is measured. */
const useWidth = (box: RefObject<HTMLElement | null>): number => {
  const [width, setWidth] = useState(0);
  // Following the box's size needs the mounted element and the browser: a layout effect, so the
  // picture is drawn at its size before the first paint.
  useLayoutEffect(() => {
    const element = box.current;
    if (element === null) return;
    setWidth(element.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [box]);
  return width;
};

/**
 * A picture: `children` drawn at their own size (`width` by `height`), scaled down to the width the
 * picture has, never up past `most`. Inert and hidden from screen readers; a transform, so the
 * kit's fixed-position parts (the sidebar) stay inside it.
 */
function Picture({
  width,
  height,
  most = 1,
  framed = true,
  className,
  children,
}: {
  readonly width: number;
  readonly height: number;
  readonly most?: number;
  /** A hairline and rounded corners round the picture. */
  readonly framed?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const room = useWidth(box);
  const scale = room === 0 ? most : Math.min(most, room / width);
  return (
    <div ref={box} className={cn("w-full min-w-0", className)}>
      <div
        aria-hidden
        inert
        className={cn(
          "relative overflow-hidden bg-background select-none",
          framed && "rounded-lg border",
        )}
        style={{ width: width * scale, height: height * scale }}
      >
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{ width, height, transform: `scale(${scale})` }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * The kit's sidebar parts read the sidebar's state; a picture has its own, always open, so the
 * real sidebar's fold and ⌘B leave it as drawn.
 */
function PictureSidebar({ children }: { readonly children: ReactNode }) {
  return (
    <SidebarProvider
      open
      onOpenChange={keepOpen}
      style={{ "--sidebar-width": SIDEBAR_WIDTH, "--sidebar-width-icon": SIDEBAR_RAIL_WIDTH }}
      className="block min-h-0"
    >
      <NoSearch>{children}</NoSearch>
    </SidebarProvider>
  );
}

const keepOpen = () => {};

/** A numbered dot on a picture, matching a numbered line beside it. */
function Dot({ n, className }: { readonly n: number; readonly className?: string }) {
  return (
    <span
      className={cn(
        "absolute z-50 grid size-7 place-items-center rounded-full bg-foreground text-sm font-semibold text-background",
        className,
      )}
    >
      {n}
    </span>
  );
}

/** A numbered line beside a picture: the number, a name, what it is. */
function Callout({
  n,
  name,
  children,
}: {
  readonly n: number;
  readonly name: string;
  readonly children: ReactNode;
}) {
  return (
    <li className="flex gap-3 border-b py-3 first:border-t">
      <span
        aria-hidden
        className="mt-px grid size-5.5 shrink-0 place-items-center rounded-full bg-foreground text-2xs font-semibold text-background"
      >
        {n}
      </span>
      <span className="grid gap-0.5">
        <span className="text-prose font-semibold text-foreground max-lg:text-sm">{name}</span>
        <span className="text-row text-pretty text-muted-foreground">{children}</span>
      </span>
    </li>
  );
}

// ——— Screen 1: how the parts nest ———

/** One part of Mend: its name and what it is, beside its picture, indented under its parent. */
function Noun({
  name,
  depth,
  picture,
  children,
}: {
  readonly name: string;
  readonly depth: number;
  readonly picture: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid items-start gap-x-10 gap-y-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <dl className="grid gap-0.5 max-lg:pl-(--indent)" style={{ "--indent": `${depth * 14}px` }}>
        <dt className="text-prose font-semibold text-foreground max-lg:text-sm">{name}</dt>
        <dd className="text-row text-pretty text-muted-foreground max-lg:text-sm">{children}</dd>
      </dl>
      <div
        className="relative min-w-0 pl-(--indent) lg:pl-(--indent-lg)"
        style={{ "--indent": `${depth * 14}px`, "--indent-lg": `${depth * 24}px` }}
      >
        {depth === 0 ? null : (
          <span
            aria-hidden
            className="absolute top-0 bottom-1/2 w-3 rounded-bl-md border-b border-l"
            style={{ left: `calc(var(--indent) - 12px)` }}
          />
        )}
        {picture}
      </div>
    </div>
  );
}

const CARD = "w-fit max-w-full rounded-lg border bg-background";

function NestingScreen({ names, phone, place }: ScreenProps) {
  const wide = !phone && place === "step";
  return (
    <div className="grid gap-6">
      <p className={LEAD}>{nestingIntro(names)}</p>
      <div className="grid gap-6 border-t pt-6 max-lg:gap-5 max-lg:pt-4">
        <Noun
          name="Server"
          depth={0}
          picture={
            <span className="inline-block max-w-full truncate rounded-md border bg-muted px-2.5 py-1.5 font-mono text-row text-foreground">
              {names.host === "" ? "mend.example.com" : names.host}
            </span>
          }
        >
          The computer Mend runs on. Its operator looks after it.
        </Noun>
        <Noun
          name="Organization"
          depth={1}
          picture={
            // The switcher's row at the top of the sidebar, as `OrganizationMenu` draws it.
            <span
              aria-hidden
              className="flex h-9 w-full max-w-62 items-center gap-2.25 rounded-lg border bg-sidebar px-2 text-prose font-semibold text-foreground"
            >
              <OrganizationMark name={names.organization} />
              <span className="min-w-0 flex-1 truncate">{names.organization}</span>
              <ChevronsUpDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
            </span>
          }
        >
          {organizationLine(names)}
        </Noun>
        <Noun name="Project" depth={2} picture={<ProjectPicture names={names} />}>
          A git repository added to Mend.
        </Noun>
        <Noun
          name="Worktree"
          depth={3}
          picture={
            <div className={cn(CARD, "grid gap-0.5 px-3 py-2")} aria-hidden>
              <span className="text-row font-medium text-foreground">{SAMPLE_WORKTREE}</span>
              <span className="truncate font-mono text-meta text-muted-foreground">
                {SAMPLE_BRANCH} · from main
              </span>
            </div>
          }
        >
          A branch with its own copy of the files, on the server. Each new piece of work gets one.
        </Noun>
        <Noun name="Session" depth={4} picture={<SessionsPicture names={names} />}>
          An agent at work in a worktree. You talk to it. A worktree can hold several.
        </Noun>
        <Noun name="Workspace" depth={4} picture={<WorkspacePicture wide={wide} />}>
          Where a session runs: a container or virtual machine with the worktree's files. Sessions
          in one worktree share it.
        </Noun>
        <Noun name="Change" depth={4} picture={<ChangePicture />}>
          What a worktree's sessions changed, compared with the branch it started from. You review
          it and can land it as a pull request.
        </Noun>
      </div>
      <p className={CAPTION}>{nestingCaption(names)}</p>
    </div>
  );
}

const SAMPLE_PROJECT_ID = "sample";

/** One of the project's tabs in a picture: a name, a count, and a path only to say which is open. */
const pictureTab = (label: string, path: string, count: number) => ({
  label,
  link: { to: "/projects" as const },
  path: `/${SAMPLE_PROJECT_ID}${path}`,
  count,
});

/** The project page's header: where it is, and its tabs with the Worktrees tab open. */
function ProjectPicture({ names }: { readonly names: FitsNames }) {
  return (
    <Picture width={420} height={92} most={1}>
      <div className="flex h-11 items-center gap-2 px-3 text-prose">
        <PanelLeftIcon className="size-4 text-muted-foreground" />
        <span className="h-4 w-px bg-border" />
        <span className="text-muted-foreground">Projects</span>
        <span className="text-faint">/</span>
        <span className="truncate font-medium text-foreground">{names.project}</span>
      </div>
      <TabLine
        name={names.project}
        current={`/${SAMPLE_PROJECT_ID}/worktrees`}
        tabs={[
          pictureTab("Sessions", "", 6),
          pictureTab("Worktrees", "/worktrees", 7),
          pictureTab("Resources", "/resources", 2),
          pictureTab("Skills", "/skills", 5),
        ]}
        className="px-3"
      />
    </Picture>
  );
}

/** Two sessions in the worktree, as the sidebar lists them (`SidebarRow`). */
function SessionsPicture({ names }: { readonly names: FitsNames }) {
  return (
    <Picture width={300} height={108} most={1}>
      <PictureSidebar>
        <div className="bg-sidebar p-1.5">
          <SidebarMenu>
            <SidebarRow
              sessionId="sample-retry"
              title={SAMPLE_SESSION}
              project={names.project}
              status="Asked a question"
              age="4m"
            />
            <SidebarRow
              sessionId="sample-regression"
              title="Add a regression test for 409s"
              project={names.project}
              status="Running"
              age="1m"
            />
          </SidebarMenu>
        </div>
      </PictureSidebar>
    </Picture>
  );
}

/** The Workspace group of a session's Details tab. */
function WorkspacePicture({ wide }: { readonly wide: boolean }) {
  return (
    <Picture width={wide ? 460 : 380} height={110} most={1}>
      <div className="px-4 text-row tabular-nums">
        <Group title="Workspace">
          <dl className="grid gap-1.5">
            <Row label="Worktree">
              <Mono>{SAMPLE_WORKTREE}</Mono>
            </Row>
            <Row label="Branch">
              <Mono>{SAMPLE_BRANCH}</Mono>
            </Row>
          </dl>
        </Group>
      </div>
    </Picture>
  );
}

/** The Change tab, with the lines its change adds and removes. */
function ChangePicture() {
  return (
    <Picture width={172} height={42} most={1}>
      <Tile
        id="picture-change"
        label="Change"
        active="view:change"
        tabs={[
          {
            value: "view:change",
            tab: (
              <TileTab
                value="view:change"
                label="Change"
                kind="view"
                icon={<FileDiffIcon />}
                added={97}
                removed={14}
              />
            ),
            body: null,
          },
        ]}
        focused={false}
        className="[&_[data-tile-strip]]:border-b-0"
      />
    </Picture>
  );
}

// ——— Screen 2: inside a session ———

const SESSION_LINES = {
  first:
    "After a 503, the retry wrapper sent the charge again without an idempotency key. If the first attempt was slow, the customer got charged twice. I added a key based on the order id, and the tests then passed 200 out of 200 times.",
  ask: "Should we back off on a 409 too? Stripe sends it while the first request is still being processed.",
  second:
    "A 409 now backs off like a 503 and keeps the same key, so Stripe matches the retry to the first request. I added a test for the 409, and the payment tests passed 200 out of 200 times.",
};

/** The session's conversation tab, its body: two turns, a message between them, the reply box. */
function ConversationBody({ phone }: { readonly phone: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-hidden px-6 pt-4">
        <Message>
          <MessageContent className="gap-3">
            <MessageHeader className="px-0 text-meta font-normal">
              Claude Code · turn 3
            </MessageHeader>
            <p className="text-prose text-foreground">{SESSION_LINES.first}</p>
          </MessageContent>
        </Message>
        <ConversationMarker label="Checkpoint · 2 files changed" />
        <UserMessage>{SESSION_LINES.ask}</UserMessage>
        <Message>
          <MessageContent className="gap-3">
            <MessageHeader className="px-0 text-meta font-normal">
              Claude Code · turn 4
            </MessageHeader>
            <p className="text-prose text-foreground">{SESSION_LINES.second}</p>
          </MessageContent>
        </Message>
        <ConversationMarker label="Checkpoint · 2 files changed" />
      </div>
      <div className="relative shrink-0 px-4 pb-4">
        <PromptInput
          size={phone ? "touch" : "default"}
          placeholder="Reply to Claude Code…"
          harness="Claude Code"
          model="Opus"
          usage="41k of 200k"
        />
      </div>
    </div>
  );
}

/** The Details tab's body: the workspace, its checks and services, its sessions. */
function DetailsBody({ names }: { readonly names: FitsNames }) {
  return (
    <div className="px-7 pt-1 text-row tabular-nums">
      <Group title="Workspace">
        <dl className="grid gap-1.5">
          <Row label="Worktree">
            <Mono>{SAMPLE_WORKTREE}</Mono>
          </Row>
          <Row label="Branch">
            <Mono>{SAMPLE_BRANCH}</Mono>
          </Row>
          <Row label="Base">
            <Mono>main · 9c41e07</Mono>
          </Row>
        </dl>
      </Group>
      <Group title="Checks">
        <dl className="grid gap-1.5">
          <Row label="Tests">Passed 200 out of 200 times.</Row>
          <Row label="Type check">Passed.</Row>
        </dl>
      </Group>
      <Group title="Services">
        <dl className="grid gap-1.5">
          <Row label="web :3000" mono>
            Running
          </Row>
          <Row label="@db Postgres" mono>
            Running
          </Row>
        </dl>
      </Group>
      <Group title="Sessions in this workspace">
        <div className="grid gap-px py-2">
          <p className="font-medium">{SAMPLE_SESSION}</p>
          <p className="text-meta text-muted-foreground">
            {names.person === "" ? "You" : names.person} · Claude Code, Opus
          </p>
        </div>
      </Group>
    </div>
  );
}

const sessionTab = (phone: boolean) => (
  <TileTab
    value="session"
    label={SAMPLE_SESSION}
    kind="session"
    status="wait"
    pr="none"
    statusWords="Waiting on you"
    size={phone ? "touch" : "default"}
  />
);

const changeTab = (phone: boolean) => (
  <TileTab
    value="view:change"
    label="Change"
    kind="view"
    icon={<FileDiffIcon />}
    added={97}
    removed={14}
    size={phone ? "touch" : "default"}
  />
);

/** A session's page on a computer: the header, the conversation tile, the Change and Details tile. */
function SessionPicture({ names }: { readonly names: FitsNames }) {
  return (
    <Picture width={1160} height={860} most={0.62}>
      <PictureSidebar>
        <div className="relative flex h-[860px] flex-col bg-background">
          <WorkspaceHeader
            project={names.project}
            projectId="sample"
            worktree={SAMPLE_WORKTREE}
            branch={SAMPLE_BRANCH}
          />
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-[1.1] border-r">
              <Tile
                id="picture-session"
                label="Session"
                active="session"
                tabs={[
                  {
                    value: "session",
                    tab: sessionTab(false),
                    body: <ConversationBody phone={false} />,
                  },
                ]}
              />
            </div>
            <div className="flex min-w-0 flex-1">
              <Tile
                id="picture-views"
                label="Views"
                active="view:details"
                focused={false}
                tabs={[
                  { value: "view:change", tab: changeTab(false), body: null },
                  {
                    value: "view:details",
                    tab: (
                      <TileTab
                        value="view:details"
                        label="Details"
                        kind="view"
                        icon={<InfoIcon />}
                      />
                    ),
                    body: <DetailsBody names={names} />,
                  },
                ]}
              />
            </div>
          </div>
          <Dot n={1} className="top-3 left-[520px]" />
          <Dot n={2} className="top-[34px] left-1" />
          <Dot n={3} className="top-[34px] left-[596px]" />
          <Dot n={4} className="top-[34px] left-[728px]" />
          <Dot n={5} className="bottom-[100px] left-2" />
        </div>
      </PictureSidebar>
    </Picture>
  );
}

/** A session on a phone: the header naming the worktree, and the strip of tabs. */
function PhoneSessionTop({ names }: { readonly names: FitsNames }) {
  return (
    <Picture width={390} height={102} most={1}>
      <div className="relative">
        <PhoneHeader
          title={SAMPLE_WORKTREE}
          sub={names.project}
          back={{ link: { to: "/" }, label: "Back" }}
        />
        <Tile
          id="picture-phone"
          label="Tabs"
          active="session"
          tabs={[
            { value: "session", tab: sessionTab(true), body: null },
            { value: "view:change", tab: changeTab(true), body: null },
          ]}
          className="[&_[data-tile-strip]]:h-11"
        />
        <Dot n={1} className="top-2 left-12" />
        <Dot n={2} className="top-[44px] left-0.5" />
        <Dot n={3} className="top-[44px] left-[226px]" />
      </div>
    </Picture>
  );
}

function SessionScreen({ names, phone, place }: ScreenProps) {
  if (phone)
    return (
      <div className="grid gap-4">
        <p className={LEAD}>
          A session opens in its worktree's workspace. The conversation, the change and the
          workspace's details are tabs along the top.
        </p>
        <PhoneSessionTop names={names} />
        <ol>
          <Callout n={1} name="Worktree and project">
            The header names the worktree, with its project under it.
          </Callout>
          <Callout n={2} name="Session tab">
            The conversation with the agent. The tab shows the session's status.
          </Callout>
          <Callout n={3} name="Change tab">
            The change, file by file. You review it and land it here. Swipe the strip for Details,
            which shows the workspace.
          </Callout>
        </ol>
        <Picture width={390} height={110} most={1}>
          <div className="relative p-2">
            <PromptInput
              size="touch"
              placeholder="Reply to Claude Code…"
              harness="Claude Code"
              model="Opus"
            />
            <Dot n={4} className="top-0 left-0" />
          </div>
        </Picture>
        <ol>
          <Callout n={4} name="Reply box">
            Write to the agent here. Each message starts its next turn.
          </Callout>
        </ol>
        <p className={CAPTION}>{sessionCaption(names)}</p>
      </div>
    );
  return (
    <div className="grid gap-6">
      <p className={LEAD}>
        A session opens in its worktree's workspace. The conversation, the change and the
        workspace's details are tabs, and you can put them side by side.
      </p>
      <div
        className={cn(
          "grid items-start gap-8",
          place === "step" ? "grid-cols-[minmax(0,1fr)_240px]" : "grid-cols-1",
        )}
      >
        <SessionPicture names={names} />
        <ol className={place === "dialog" ? "grid grid-cols-2 gap-x-6" : undefined}>
          <Callout n={1} name="Project and worktree">
            Where the session works, and the worktree's branch.
          </Callout>
          <Callout n={2} name="Session tab">
            The conversation with the agent. The tab shows the session's status.
          </Callout>
          <Callout n={3} name="Change tab">
            The change, file by file. You review it and land it here.
          </Callout>
          <Callout n={4} name="Details tab">
            The workspace: its worktree, branch, checks and services.
          </Callout>
          <Callout n={5} name="Reply box">
            Write to the agent here. Each message starts its next turn.
          </Callout>
        </ol>
      </div>
      <p className={CAPTION}>{sessionCaption(names)}</p>
    </div>
  );
}

// ——— Screen 3: the sidebar ———

/** The sidebar itself (`AppSidebar`) over the sample inbox, with the reader's names. */
function SidebarPicture({ names }: { readonly names: FitsNames }) {
  const [view] = useState(() => sampleInboxView(names.project, new Date()));
  return (
    <Picture width={264} height={720} most={0.9} framed>
      <PictureSidebar>
        <div className="relative h-[720px] [&_[data-slot=sidebar-container]]:h-full [&_[data-slot=sidebar-gap]]:hidden">
          <AppSidebar
            organizationName={names.organization}
            account={{ name: names.person, email: names.email }}
            inbox={{ status: "success", view }}
            online
          />
        </div>
      </PictureSidebar>
    </Picture>
  );
}

/** The phone's inbox (`PhoneInbox`) over the sample inbox. */
function PhoneInboxPicture({ names }: { readonly names: FitsNames }) {
  const [view] = useState(() => sampleInboxView(names.project, new Date()));
  return (
    <Picture width={390} height={760} most={0.72} className="flex justify-center">
      <NoSearch>
        <div className="relative h-[760px] overflow-hidden">
          <PhoneInbox
            organizationName={names.organization}
            inbox={{ status: "success", view }}
            online
            className="min-h-0 h-full"
          />
          <Dot n={1} className="top-4 left-24" />
          <Dot n={2} className="top-4 right-16" />
          <Dot n={3} className="top-[86px] left-[150px]" />
          <Dot n={4} className="top-[132px] left-[160px]" />
          <Dot n={5} className="bottom-12 left-[180px]" />
        </div>
      </NoSearch>
    </Picture>
  );
}

/** One part of the sidebar, named, with what it is. */
function Part({ name, children }: { readonly name: string; readonly children: ReactNode }) {
  return (
    <p className="text-row text-pretty text-muted-foreground">
      <span className="mr-1.5 text-prose font-semibold text-foreground">{name}</span>
      {children}
    </p>
  );
}

function GroupTable() {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-row">
      {GROUP_WORDS.map((group) => (
        <div key={group.name} className="contents">
          <dt className="font-medium text-foreground">{group.name}</dt>
          <dd className="text-pretty text-muted-foreground">{group.words}</dd>
        </div>
      ))}
    </dl>
  );
}

function SidebarScreen({ names, phone }: ScreenProps) {
  const org = names.organization;
  if (phone)
    return (
      <div className="grid gap-4">
        <p className={LEAD}>{sidebarIntro(names, true)}</p>
        <PhoneInboxPicture names={names} />
        <ol>
          <Callout n={1} name="Inbox">
            Your sessions in {org}. On a computer this list is the sidebar.
          </Callout>
          <Callout n={2} name="Search and New session">
            Find a session or a project, or start a new session.
          </Callout>
          <Callout n={3} name="Filters">
            One project or all, yours or everyone's.
          </Callout>
          <li className="flex gap-3 border-b py-3">
            <span
              aria-hidden
              className="mt-px grid size-5.5 shrink-0 place-items-center rounded-full bg-foreground text-2xs font-semibold text-background"
            >
              4
            </span>
            <span className="grid min-w-0 flex-1 gap-1.5">
              <span className="text-sm font-semibold text-foreground">
                Sessions, in five groups
              </span>
              <GroupTable />
            </span>
          </li>
          <Callout n={5} name="Projects, Skills, Settings">
            Skills are instructions Mend copies into every session you start. Settings holds your
            account, and these screens again.
          </Callout>
        </ol>
        <p className={CAPTION}>{sidebarCaption(names, true)}</p>
      </div>
    );
  return (
    <div className="grid gap-6">
      <p className={LEAD}>{sidebarIntro(names, false)}</p>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-8">
        <div className="w-60">
          <SidebarPicture names={names} />
        </div>
        <div className="grid gap-4">
          <Part name="Organization switcher">
            {org}. If you belong to other organizations, you switch here.
          </Part>
          <Part name="Search">Find a session or a project. The pencil starts a new session.</Part>
          <Part name="Projects">Every project you can open in {org}.</Part>
          <Part name="Skills">Instructions Mend copies into every session you start.</Part>
          <Part name="Filters">
            Which sessions the list shows: one project or all, yours or everyone's.
          </Part>
          <div className="grid gap-2 border-l pl-4">
            <p className="text-prose font-semibold text-foreground">Sessions, in five groups</p>
            <GroupTable />
            <p className="text-row text-pretty text-muted-foreground">
              A row is one session: its title, then its project, what happened and when. Running,
              Snoozed and Done start folded.
            </p>
          </div>
          <Part name="Settings">Your account, this browser, your projects and {org}.</Part>
          <Part name="Account menu">Sign out, or open these screens again.</Part>
        </div>
      </div>
      <p className={CAPTION}>{sidebarCaption(names, false)}</p>
    </div>
  );
}
