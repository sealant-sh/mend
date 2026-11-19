import {
  Approval,
  ApprovalArguments,
  ApprovalCommand,
  ApprovalDiff,
} from "@mend/ui/components/approval";
import { Banner, InlineAlert } from "@mend/ui/components/banner";
import {
  CommandPalette,
  CommandPaletteEmpty,
  CommandPaletteGroup,
  CommandPaletteItem,
  CommandPaletteMatch,
} from "@mend/ui/components/command-palette";
import { Conversation, ConversationItem } from "@mend/ui/components/conversation";
import { ConversationMarker } from "@mend/ui/components/conversation-marker";
import { CopyField } from "@mend/ui/components/copy-field";
import { FileAttachment } from "@mend/ui/components/file-attachment";
import { Lump, type LumpPr, type LumpStatus } from "@mend/ui/components/lump";
import { ComposerCard, PromptInput, PromptInputModel } from "@mend/ui/components/prompt-input";
import { Question, QuestionEarlier } from "@mend/ui/components/question";
import { Segmented } from "@mend/ui/components/segmented";
import { Status } from "@mend/ui/components/status";
import { TraceRow } from "@mend/ui/components/trace-row";
import { Button } from "@mend/ui/components/ui/button";
import { Empty } from "@mend/ui/components/ui/empty";
import { Tooltip, TooltipContent, TooltipTrigger } from "@mend/ui/components/ui/tooltip";
import { UserMessage } from "@mend/ui/components/user-message";
import {
  FileSearchIcon,
  FlaskConicalIcon,
  GitPullRequestArrowIcon,
  ListChecksIcon,
  PencilIcon,
  PlugIcon,
  SettingsIcon,
  SquareTerminalIcon,
} from "lucide-react";
import { useState } from "react";

// `?open=command-palette` opens the palette on load, for screenshots.
const open = new URLSearchParams(window.location.search).get("open");

function Row({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      {label === undefined ? null : (
        <span className="text-meta text-muted-foreground">{label}</span>
      )}
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

function StatusDemo() {
  return (
    <Row>
      <Status tone="run">Running</Status>
      <Status tone="wait">Waiting on you</Status>
      <Status tone="ok">Completed</Status>
      <Status tone="bad">Failed</Status>
      <Status tone="idle">Stopped</Status>
    </Row>
  );
}

const statuses: LumpStatus[] = ["run", "wait", "done", "fail", "stop", "idle"];
const prs: LumpPr[] = ["none", "open", "merged", "conflict"];

function LumpDemo() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid w-fit grid-cols-[auto_repeat(6,--spacing(12))] items-center gap-y-2 text-meta text-muted-foreground">
        <span />
        {statuses.map((status) => (
          <span key={status} className="text-center">
            {status}
          </span>
        ))}
        {prs.map((pr) => (
          <div key={pr} className="contents">
            <span className="pe-3">pr {pr}</span>
            {statuses.map((status) => (
              <span key={status} className="flex justify-center">
                <Lump status={status} pr={pr} className="size-4" />
              </span>
            ))}
          </div>
        ))}
      </div>
      <Row label="On a tile tab, moving: running kneads, waiting lifts (still with reduced motion)">
        {(["run", "wait", "done"] as const).map((status) => (
          <Lump key={status} status={status} pr="open" moving className="size-4" />
        ))}
      </Row>
      <Row label="In the sidebar rail, with its title as a tooltip">
        {(
          [
            ["wait", "none", "Rotate staging database credentials"],
            ["run", "open", "Fix flaky checkout retry"],
            ["done", "merged", "Show prices in the shopper's currency"],
            ["fail", "conflict", "Upgrade to React Router 8"],
          ] as const
        ).map(([status, pr, title]) => (
          <Tooltip key={title}>
            <TooltipTrigger
              render={<Button variant="ghost" size="icon" aria-label={title} />}
              className="data-[active=true]:bg-sidebar-accent"
              data-active={status === "run"}
            >
              <Lump status={status} pr={pr} className="size-4" />
            </TooltipTrigger>
            <TooltipContent side="right">{title}</TooltipContent>
          </Tooltip>
        ))}
      </Row>
    </div>
  );
}

const sshKey =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq7v2kR9cXo4mWb1T8sLzP0dNf3eYhJ6uQa5KtV2xBn mend:linus@northwind.dev";

function CopyFieldDemo() {
  return (
    <div className="flex flex-col gap-4">
      <Row label="size default">
        <CopyField className="w-full max-w-xl" value={sshKey} label="Copy key" />
      </Row>
      <Row label="size touch">
        <CopyField
          className="w-full max-w-sm"
          size="touch"
          value="mend login --server mend.northwind.dev"
          label="Copy command"
        />
      </Row>
    </div>
  );
}

const notices = [
  {
    tone: "info",
    title: "You're offline.",
    text: "This is your inbox from 9:38. Answering, approving and starting sessions need a connection.",
    action: "Retry",
  },
  {
    tone: "warning",
    title: "Grace Hopper has shared control.",
    text: "Ask Grace for control to send a message.",
    action: "Ask for control",
  },
  {
    tone: "error",
    title: "The session couldn't start.",
    text: "The workspace image failed to build. Its log has the details.",
    action: "Try again",
  },
  {
    tone: "success",
    title: "Git access works.",
    text: "Mend pushed to a test branch and removed it.",
    action: undefined,
  },
] as const;

function BannerDemo() {
  return (
    <div className="flex flex-col gap-4">
      {(["inline", "stacked"] as const).map((layout) => (
        <Row key={layout} label={`layout ${layout}`}>
          <div className="w-full border-t">
            {notices.map(({ tone, title, text, action }) => (
              <Banner
                key={tone}
                tone={tone}
                layout={layout}
                title={title}
                actions={
                  action === undefined ? undefined : (
                    <Button size={layout === "stacked" ? "touch" : "sm"} variant="secondary">
                      {action}
                    </Button>
                  )
                }
              >
                {text}
              </Banner>
            ))}
            <Banner tone="info" layout={layout}>
              With no title, the text stands on its own.
            </Banner>
          </div>
        </Row>
      ))}
    </div>
  );
}

function InlineAlertDemo() {
  return (
    <div className="flex flex-col gap-4">
      <Row label="size default">
        <div className="grid w-full gap-3 sm:grid-cols-2">
          <InlineAlert
            tone="error"
            title="GitHub refused the key."
            actions={
              <Button size="sm" variant="secondary">
                Check again
              </Button>
            }
          >
            GitHub answered <code>Permission denied (publickey)</code>. Check that you copied the
            whole key, starting with <code>ssh-ed25519</code>, and added it under SSH keys in your
            GitHub settings.
          </InlineAlert>
          {notices.slice(0, 2).map(({ tone, title, text }) => (
            <InlineAlert key={tone} tone={tone} title={title}>
              {text}
            </InlineAlert>
          ))}
          <InlineAlert tone="success" title="Git access works.">
            Mend pushed to a test branch and removed it.
          </InlineAlert>
        </div>
      </Row>
      <Row label="size touch">
        <InlineAlert
          className="max-w-sm"
          size="touch"
          tone="error"
          title="GitHub refused the key."
          actions={
            <>
              <Button size="touch" variant="secondary">
                Check again
              </Button>
              <Button size="touch" variant="secondary">
                Copy key
              </Button>
            </>
          }
        >
          Add the key to your GitHub account, then check again.
        </InlineAlert>
      </Row>
    </div>
  );
}

const paletteResults = [
  {
    group: "Actions",
    items: [
      {
        value: "land",
        icon: <GitPullRequestArrowIcon />,
        name: "Land change…",
        context: "Fix flaky checkout retry",
      },
      { value: "new", icon: <PencilIcon />, name: "New session", context: "checkout-api" },
    ],
  },
  {
    group: "Sessions",
    items: [
      {
        value: "s1",
        icon: <SquareTerminalIcon />,
        name: "Fix flaky checkout retry",
        context: "checkout-api",
        status: "wait",
      },
      {
        value: "s2",
        icon: <SquareTerminalIcon />,
        name: "Add idempotency keys to refunds",
        context: "checkout-api",
        status: "run",
      },
    ],
  },
  {
    group: "Settings",
    items: [
      {
        value: "auto",
        icon: <SettingsIcon />,
        name: "Automatic landing",
        context: "Account › Your automation",
      },
    ],
  },
] as const;

function CommandPaletteDemo() {
  const [isOpen, setOpen] = useState(open === "command-palette");
  const [query, setQuery] = useState(open === "command-palette" ? "land" : "");
  const needle = query.trim().toLowerCase();
  const groups = paletteResults
    .map(({ group, items }) => ({
      group,
      items: items.filter((item) => item.name.toLowerCase().includes(needle)),
    }))
    .filter(({ items }) => items.length > 0);
  const count = groups.reduce((total, { items }) => total + items.length, 0);

  return (
    <Row>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Open the palette
      </Button>
      <span className="text-meta text-muted-foreground">
        Type “land” for two results, or anything else for none.
      </span>
      <CommandPalette
        open={isOpen}
        onOpenChange={setOpen}
        query={query}
        onQueryChange={setQuery}
        placeholder="Search Northwind"
        scope="in Northwind"
        count={count === 1 ? "1 result" : `${count} results`}
        empty={count === 0}
      >
        {groups.map(({ group, items }) => (
          <CommandPaletteGroup key={group} heading={group}>
            {items.map((item) => (
              <CommandPaletteItem
                key={item.value}
                value={item.value}
                icon={item.icon}
                context={item.context}
                trailing={
                  "status" in item ? (
                    <Status tone={item.status}>
                      {item.status === "wait" ? "Waiting on you" : "Running"}
                    </Status>
                  ) : undefined
                }
                onSelect={() => setOpen(false)}
              >
                <CommandPaletteMatch text={item.name} query={query} />
              </CommandPaletteItem>
            ))}
          </CommandPaletteGroup>
        ))}
        <CommandPaletteEmpty>
          <Empty kind="inline">Nothing in Northwind matches “{query}”.</Empty>
        </CommandPaletteEmpty>
      </CommandPalette>
    </Row>
  );
}

function UserMessageDemo() {
  return (
    <div className="flex flex-col gap-6">
      <Row label="size default, with an attachment">
        <UserMessage
          className="max-w-conversation"
          byline="Ada Lovelace · 13 Nov, 10:42"
          attachments={<FileAttachment name="ci-failure.log" fileSize="14 KB" />}
        >
          Checkout fails about 1 in 50 CI runs with a duplicate charge. Log attached. Find out why
          and fix it without changing the public API.
        </UserMessage>
      </Row>
      <Row label="size touch">
        <UserMessage className="max-w-sm" size="touch" byline="You · 10:18">
          Rotate the staging database password with the terraform module.
        </UserMessage>
      </Row>
      <Row label="pending: sent into a running turn">
        <UserMessage
          className="max-w-conversation"
          pending
          byline="Sent into this turn. Claude Code reads it when its current step finishes."
        >
          Also cover partial refunds. Each partial refund needs its own key.
        </UserMessage>
      </Row>
    </div>
  );
}

function FileAttachmentDemo() {
  return (
    <div className="flex flex-col gap-4">
      <Row label="layout stacked">
        <FileAttachment name="ci-failure.log" fileSize="14 KB" />
        <FileAttachment
          name="checkout-retry-timeline-2026-11-13-full-export.json"
          fileSize="1.2 MB"
        />
      </Row>
      <Row label="layout row (the phone composer)">
        <FileAttachment
          layout="row"
          name="checkout-retry-timeline-2026-11-13-full-export.json"
          fileSize="1.2 MB"
        />
      </Row>
    </div>
  );
}

function TraceRowDemo() {
  return (
    <div className="flex max-w-conversation flex-col">
      <TraceRow
        icon={<ListChecksIcon />}
        title="Worked for 2m 4s"
        description="1 command failed"
        defaultOpen
      >
        <TraceRow
          icon={<FileSearchIcon />}
          title="Read 6 files in src/payments"
          description="0.8s"
        />
        <TraceRow
          tone="error"
          icon={<SquareTerminalIcon />}
          title="Ran"
          code="pnpm vitest run payments --repeat 200"
          description="41 failed of 200 · 38s"
        />
        <TraceRow icon={<PencilIcon />} title="Edited src/payments/retry.ts" description="+41 −9" />
        <TraceRow
          tone="running"
          icon={<FlaskConicalIcon />}
          title="Running tests"
          description="112 of 200"
        />
        <TraceRow tone="pending" icon={<SquareTerminalIcon />} title="Run the full suite" />
      </TraceRow>
      <TraceRow icon={<ListChecksIcon />} title="Worked for 1m 6s" description="5 steps">
        <TraceRow icon={<FileSearchIcon />} title="Read modules/staging_db" description="0.4s" />
      </TraceRow>
    </div>
  );
}

function MarkerDemo() {
  return (
    <div className="flex max-w-conversation flex-col gap-3">
      <ConversationMarker
        label="Checkpoint 7"
        sha="4f2a91c"
        link={
          <Button variant="link" size="sm" className="text-meta">
            Review from here
          </Button>
        }
      />
      <ConversationMarker kind="status" label="Running tests…" />
      <ConversationMarker
        kind="status"
        label="Waiting for the staging database to accept the new password before running the migration check again, which can take a minute."
      />
    </div>
  );
}

const questionChoices = [
  {
    value: "final",
    label: "Treat 409 as final",
    description: "Return the error to the caller without retrying.",
  },
  {
    value: "retry",
    label: "Back off and retry",
    description: "Retry 3 times with backoff before failing.",
  },
];

function QuestionDemo() {
  const [picked, setPicked] = useState<string | null>("retry");
  return (
    <div className="flex flex-col gap-6">
      <Row label="size default, a choice picked">
        <ComposerCard className="mx-0 w-full">
          <Question
            title="Should the retry back off on a 409?"
            description="Stripe sends a 409 when a request with the same key is still being processed."
            choices={questionChoices}
            other={{ value: "other", label: "Something else" }}
            value={picked}
            onValueChange={setPicked}
            hint="Press Enter to send your answer, or add a note below."
          />
          <PromptInput
            placeholder={picked === null ? "Or write your own answer" : "Add a note (optional)"}
            allowEmpty={picked !== null}
            harness="Claude Code"
            model={<PromptInputModel>Opus</PromptInputModel>}
            onAttach={() => {}}
          />
        </ComposerCard>
      </Row>
      <Row label="size touch, nothing picked">
        <ComposerCard className="mx-0 w-full max-w-sm">
          <Question
            size="touch"
            title="Should the retry back off on a 409?"
            choices={questionChoices}
            other={{ value: "other", label: "Something else" }}
            hint="Press Enter to send your answer."
          />
          <PromptInput
            size="touch"
            placeholder="Or write your own answer"
            harness="Claude Code"
            model={<PromptInputModel size="touch">Opus</PromptInputModel>}
            onAttach={() => {}}
          />
        </ComposerCard>
      </Row>
      <Row label="two parts, on the second: the first answer folded above it, with step">
        <ComposerCard className="mx-0 w-full">
          <QuestionEarlier label="Question 1" answer="Back off and retry" onChange={() => {}} />
          <Question
            step="2 of 2"
            name="wait"
            title="How long should a refund wait in total?"
            description="The waits add up across retries. After this long, the refund is marked as failed."
            choices={[
              { value: "2s", label: "2 seconds", description: "Waits 250ms, 500ms and 1s." },
              { value: "10s", label: "10 seconds", description: "Waits 1s, 3s and 6s." },
            ]}
            other={{ value: "other", label: "Something else" }}
            defaultValue="2s"
            hint="Press Enter to send both answers. A note goes with both."
          />
          <PromptInput
            placeholder="Add a note to both answers (optional)"
            allowEmpty
            harness="Claude Code"
            model={<PromptInputModel>Opus</PromptInputModel>}
          />
        </ComposerCard>
      </Row>
      <Row label="multiple: several choices picked">
        <ComposerCard className="mx-0 w-full">
          <Question
            multiple
            name="areas"
            title="Which payment flows should back off?"
            choices={[
              { value: "charges", label: "Charges" },
              { value: "refunds", label: "Refunds" },
              { value: "payouts", label: "Payouts" },
            ]}
            values={["charges", "refunds"]}
            hint="Pick any, then press Enter."
          />
          <PromptInput placeholder="Add a note (optional)" allowEmpty harness="Claude Code" />
        </ComposerCard>
      </Row>
    </div>
  );
}

function PromptInputDemo() {
  const model = <PromptInputModel>Opus</PromptInputModel>;
  return (
    <div className="flex flex-col gap-6">
      <Row label="state default">
        <PromptInput
          className="w-full max-w-conversation"
          placeholder="Reply to Claude Code…"
          harness="Claude Code"
          model={model}
          usage="41k of 200k"
          onAttach={() => {}}
        />
      </Row>
      <Row label="state running">
        <PromptInput
          className="w-full max-w-conversation"
          state="running"
          placeholder="Message Claude Code while it works"
          harness="Claude Code"
          model={model}
          usage="41k of 200k"
          onAttach={() => {}}
        />
      </Row>
      <Row label="state running, stopping the turn">
        <PromptInput
          className="w-full max-w-conversation"
          state="running"
          stopping
          placeholder="Message Claude Code while it works"
          harness="Claude Code"
          model={model}
          onAttach={() => {}}
        />
      </Row>
      <Row label="state locked">
        <PromptInput
          className="w-full max-w-conversation"
          state="locked"
          notice="Only Grace Hopper can message this session. You can still read it and review the change."
        />
      </Row>
      <Row label="state locked, with what the viewer can do instead">
        <PromptInput
          className="w-full max-w-conversation"
          state="locked"
          notice="Only Grace Hopper can message this session."
          noticeAction={
            <Button type="button" variant="outline" size="sm">
              Start your own session in this workspace
            </Button>
          }
        />
      </Row>
      <Row label="state locked, with an action, touch">
        <PromptInput
          className="w-[358px]"
          size="touch"
          state="locked"
          notice="Only Grace Hopper can message this session. You can read it and review the change."
          noticeAction={
            <Button type="button" variant="outline" size="touch">
              Start your own session in this workspace
            </Button>
          }
        />
      </Row>
      <Row label="in narrow tiles: 420px hides the context count, 360px the harness too">
        <PromptInput
          className="w-105"
          placeholder="Reply to Codex…"
          harness="Codex"
          model={<PromptInputModel>gpt-6.1</PromptInputModel>}
          usage="41k of 200k"
          onAttach={() => {}}
        />
        <PromptInput
          className="w-90"
          placeholder="Reply to Codex…"
          harness="Codex"
          model={<PromptInputModel>gpt-6.1</PromptInputModel>}
          usage="41k of 200k"
          onAttach={() => {}}
        />
      </Row>
      <Row label="size touch, default and running">
        <PromptInput
          className="w-full max-w-sm"
          size="touch"
          placeholder="Reply to Claude Code…"
          harness="Claude Code"
          model={<PromptInputModel size="touch">Opus</PromptInputModel>}
          usage="41k of 200k"
          onAttach={() => {}}
        />
        <PromptInput
          className="w-full max-w-sm"
          size="touch"
          state="running"
          placeholder="Message Claude Code while it works"
          harness="Claude Code"
          model={<PromptInputModel size="touch">Opus</PromptInputModel>}
          onAttach={() => {}}
        />
      </Row>
      <Row label="submitLabel: the New session composer, then blocked (the picked agent has no login)">
        <PromptInput
          className="w-full max-w-conversation"
          placeholder="Describe a task or ask a question"
          model={
            <>
              <PromptInputModel>checkout-api</PromptInputModel>
              <PromptInputModel>Claude Code · Opus</PromptInputModel>
              <PromptInputModel>New worktree</PromptInputModel>
            </>
          }
          submitLabel="Start session"
        />
        <PromptInput
          className="w-full max-w-conversation"
          defaultValue="Add idempotency keys to refund requests."
          model={
            <>
              <PromptInputModel>checkout-api</PromptInputModel>
              <PromptInputModel>Codex</PromptInputModel>
              <PromptInputModel>New worktree</PromptInputModel>
            </>
          }
          submitLabel="Start session"
          blocked
        />
      </Row>
    </div>
  );
}

const approvalChoices = [
  {
    value: "once",
    label: "Approve once",
    description: "Claude Code asks again before its next command.",
  },
  {
    value: "always",
    label: (
      <>
        Always allow <code>terraform apply</code> in this session
      </>
    ),
    description: "Claude Code won't ask again until the session ends.",
  },
];

function ApprovalDetail() {
  return (
    <>
      <ApprovalCommand
        where={
          <>
            Runs in <code>infra/</code>
          </>
        }
        command="terraform apply -target=module.staging_db"
      />
      <ul className="grid gap-0.5 text-muted-foreground">
        <li>
          <b className="font-medium text-foreground">Replaces</b>{" "}
          <code>random_password.staging_db</code>
        </li>
        <li>
          <b className="font-medium text-foreground">Updates</b>{" "}
          <code>aws_secretsmanager_secret_version.staging_db</code> in account{" "}
          <code>northwind-staging</code>
        </li>
      </ul>
    </>
  );
}

function ApprovalDemo() {
  return (
    <div className="flex flex-col gap-6">
      <Row label="choices two, size default">
        <ComposerCard className="mx-0 w-full">
          <Approval
            title="Claude Code wants to run a command"
            choices={approvalChoices}
            defaultValue="once"
            actions={
              <>
                <Button size="sm" variant="outline">
                  Deny
                </Button>
                <Button size="sm">Approve</Button>
              </>
            }
          >
            <ApprovalDetail />
          </Approval>
          <PromptInput
            placeholder="Or tell Claude Code what to do instead"
            harness="Claude Code"
            model={<PromptInputModel>Opus</PromptInputModel>}
            usage="19k of 200k"
            onAttach={() => {}}
          />
        </ComposerCard>
      </Row>
      <Row label="choices none, size touch">
        <ComposerCard className="mx-0 w-full max-w-sm">
          <Approval
            size="touch"
            title="Claude Code wants to use a tool"
            actions={
              <>
                <Button size="touch" variant="outline">
                  Deny
                </Button>
                <Button size="touch">Approve</Button>
              </>
            }
          >
            <p className="text-muted-foreground">
              <code>linear.save_issue</code> with <code>{'{ id: "SLNT-1092" }'}</code>
            </p>
          </Approval>
          <PromptInput
            size="touch"
            placeholder="Or tell Claude Code what to do instead"
            harness="Claude Code"
            model={<PromptInputModel size="touch">Opus</PromptInputModel>}
            onAttach={() => {}}
          />
        </ComposerCard>
      </Row>
      <Row label="a file edit: ApprovalDiff">
        <ComposerCard className="mx-0 w-full">
          <Approval
            title="Codex wants to edit a file"
            actions={
              <>
                <Button size="sm" variant="outline">
                  Deny
                </Button>
                <Button size="sm">Approve</Button>
              </>
            }
          >
            <ApprovalDiff
              path="migrations/0043_drop_coupon.sql"
              diff={[
                "@@ -1,3 +1,5 @@",
                " BEGIN;",
                "-ALTER TABLE legacy_coupons RENAME TO legacy_coupons_old;",
                "+-- Coupons live in billing.discounts since 0039.",
                "+DROP INDEX IF EXISTS legacy_coupons_code_idx;",
                "+DROP TABLE IF EXISTS legacy_coupons;",
                " COMMIT;",
              ].join("\n")}
            />
          </Approval>
          <PromptInput placeholder="Or tell Codex what to do instead" harness="Codex" />
        </ComposerCard>
      </Row>
      <Row label="a tool: ApprovalArguments">
        <ComposerCard className="mx-0 w-full">
          <Approval
            title="Claude Code wants to use a tool"
            actions={
              <>
                <Button size="sm" variant="outline">
                  Deny
                </Button>
                <Button size="sm">Approve</Button>
              </>
            }
          >
            <ApprovalArguments
              icon={<PlugIcon />}
              name="linear · create_issue"
              entries={[
                ["team", "NW"],
                ["title", "Back off on a 409 from Stripe when refunding"],
                ["labels", '["payments", "follow-up"]'],
              ]}
            />
          </Approval>
          <PromptInput placeholder="Or tell Claude Code what to do instead" harness="Claude Code" />
        </ComposerCard>
      </Row>
    </div>
  );
}

const replies = [
  "Reading the retry wrapper and its tests.",
  "The wrapper sends the charge again after a 503 without an idempotency key.",
  "I added a key based on the order id. The tests pass 200 out of 200 times.",
  "Since then I've added backoff(), which hasn't been tested yet.",
];

function ConversationDemo() {
  const [count, setCount] = useState(3);
  return (
    <div className="flex flex-col gap-3">
      <Row>
        <Button variant="secondary" size="sm" onClick={() => setCount((n) => n + 1)}>
          Add a message
        </Button>
        <span className="text-meta text-muted-foreground">
          It follows new messages, unless you scroll up first.
        </span>
      </Row>
      <div className="h-96 rounded-lg border">
        <Conversation label="Fix flaky checkout retry">
          <ConversationItem messageId="ask">
            <UserMessage byline="Ada Lovelace · 13 Nov, 10:42">
              Checkout fails about 1 in 50 CI runs with a duplicate charge. Find out why.
            </UserMessage>
          </ConversationItem>
          {Array.from({ length: count }, (_, index) => (
            <ConversationItem key={`reply-${index}`} messageId={`reply-${index}`}>
              <p className="text-prose">
                {index + 1}. {replies[index % replies.length]}
              </p>
            </ConversationItem>
          ))}
        </Conversation>
      </div>
    </div>
  );
}

function SegmentedDemo() {
  const [uses, setUses] = useState<"project" | "worktree" | "off">("project");
  const [from, setFrom] = useState<"file" | "url">("file");
  return (
    <div className="flex flex-col gap-4">
      <Row label="Default">
        <Segmented
          aria-label="How fix-checkout-retry uses @db"
          value={uses}
          onValueChange={setUses}
          options={[
            { value: "project", label: "Shared" },
            { value: "worktree", label: "Own" },
            { value: "off", label: "Off" },
          ]}
        />
        <Segmented
          aria-label="How try-vitest-4 uses @db"
          disabled
          value="off"
          onValueChange={() => undefined}
          options={[
            { value: "project", label: "Shared" },
            { value: "worktree", label: "Own" },
            { value: "off", label: "Off" },
          ]}
        />
      </Row>
      <Row label="Touch">
        <Segmented
          aria-label="Load from"
          size="touch"
          className="w-full"
          value={from}
          onValueChange={setFrom}
          options={[
            { value: "file", label: "Dump file" },
            { value: "url", label: "Postgres URL" },
          ]}
        />
      </Row>
    </div>
  );
}

export const componentSections: ReadonlyArray<{
  id: string;
  title: string;
  Demo: () => React.ReactNode;
}> = [
  { id: "status", title: "Status", Demo: StatusDemo },
  { id: "segmented", title: "Segmented", Demo: SegmentedDemo },
  { id: "lump", title: "Lump", Demo: LumpDemo },
  { id: "copy-field", title: "Copy box (CopyField)", Demo: CopyFieldDemo },
  { id: "banner", title: "Banner", Demo: BannerDemo },
  { id: "inline-alert", title: "Inline alert", Demo: InlineAlertDemo },
  { id: "command-palette", title: "Command palette", Demo: CommandPaletteDemo },
  { id: "user-message", title: "User message", Demo: UserMessageDemo },
  { id: "attachment", title: "Attachment (FileAttachment)", Demo: FileAttachmentDemo },
  { id: "trace-row", title: "Trace row", Demo: TraceRowDemo },
  { id: "marker", title: "Marker (ConversationMarker)", Demo: MarkerDemo },
  { id: "question", title: "Questionnaire (Question) in the composer card", Demo: QuestionDemo },
  { id: "prompt-input", title: "Prompt input", Demo: PromptInputDemo },
  { id: "approval", title: "Approval in the composer card", Demo: ApprovalDemo },
  { id: "message-scroller", title: "Message scroller (Conversation)", Demo: ConversationDemo },
];
