import { InlineAlert } from "@mend/ui/components/banner";
import { Button, buttonVariants } from "@mend/ui/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@mend/ui/components/ui/field";
import { Input } from "@mend/ui/components/ui/input";
import { Textarea } from "@mend/ui/components/ui/textarea";
import { toast } from "@mend/ui/components/ui/toast";
import { ToggleGroup, ToggleGroupItem } from "@mend/ui/components/ui/toggle-group";
import { cn } from "@mend/ui/lib/utils";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { GitPullRequestIcon } from "lucide-react";
import { type ReactNode, useId, useState, useSyncExternalStore } from "react";

import { QueryError } from "#/components/route-screens";
import { RichText } from "#/components/session/rich-text";
import {
  type ChangeLandingsDto,
  probeLandings,
  type ReviewDiffDto,
  type SessionDetailDto,
  type SessionInboxRowDto,
} from "#/lib/api";
import { readDraft, subscribeDrafts, writeDraft } from "#/lib/drafts";
import {
  checkLine,
  defaultPullRequestTitle,
  describedFileOfReview,
  descriptionPreview,
  factLine,
  factsWithProbe,
  factTone,
  forkNote,
  heldBack,
  landButtonLabel,
  landedSentence,
  landingBase,
  landingProblem,
  landRequestOf,
  nextRemoteBranch,
  originPlace,
  pullRequestToUpdate,
  pullRequestWords,
  remoteLine,
  reportProblem,
  stillEditing,
  type ToolbarLanding,
  toolbarLanding,
  unavailableWords,
} from "#/lib/landing";
import { usePhone } from "#/lib/phone";
import { failureWords } from "#/lib/refusal";
import { signedInOptions } from "#/lib/sign-in";
import { useTRPC } from "#/lib/trpc";

import { Overlay } from "../projects/overlay.tsx";

/**
 * Landing in the Change view (docs/adr/0007-landing.md; Doop page 4 "Session · Land dialog",
 * "Change · landed", "Change · landed, new checkpoint", "Session · Land dialog · update pull
 * request", "Push refused"): the toolbar's line about the pull request, its one button, and the
 * Land dialog. Only the change's owner lands; anyone who can see the change reads what landed.
 * The dialog is open while the address ends in `#land`, so a link (`/changes/<id>#land`, the
 * workspace "…") opens it.
 */

const LAND_HASH = "land";

/** Everything the Change view knows that landing needs. */
export interface LandPlace {
  readonly detail: SessionDetailDto;
  readonly changeId: string;
  readonly review: ReviewDiffDto;
  /** The sessions working in this workspace, from the inbox. */
  readonly sessions: ReadonlyArray<SessionInboxRowDto>;
}

/** What the Change view places: the toolbar's note and button, the narrow band, the dialog. */
export interface ChangeLanding {
  /** Replaces the toolbar's note once something landed; null before. */
  readonly note: ReactNode;
  readonly action: ReactNode;
  /** Under the toolbar when the view is narrow, where the note is hidden. */
  readonly band: ReactNode;
  readonly dialog: ReactNode;
}

/** The pull request's line and link, with the toolbar's icon. */
function LandedLine({ landing }: { readonly landing: ToolbarLanding }) {
  if (landing.line === null) return null;
  return (
    <span className="inline-flex flex-wrap items-baseline justify-end gap-x-1.5">
      <GitPullRequestIcon aria-hidden className="size-3.5 shrink-0 translate-y-0.5" />
      <span>{landing.line}</span>
      {landing.pullRequest === null ? null : (
        <a
          href={landing.pullRequest.url}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-info hover:underline"
        >
          {pullRequestWords(landing.pullRequest)}
        </a>
      )}
    </span>
  );
}

/** The dialog's open state is the address's `#land`. */
const useLandHash = () => {
  const hash = useLocation({ select: (location) => location.hash });
  const navigate = useNavigate();
  return {
    open: hash === LAND_HASH,
    setOpen: (open: boolean) =>
      void navigate({
        to: ".",
        search: (search) => search,
        hash: open ? LAND_HASH : "",
        replace: !open,
      }),
  };
};

export function useChangeLanding(place: LandPlace): ChangeLanding {
  const trpc = useTRPC();
  const read = useQuery(trpc.landings.forChange.queryOptions({ id: place.changeId }));
  const { open, setOpen } = useLandHash();
  const phone = usePhone();

  const dialog = (
    <Overlay
      open={open}
      onOpenChange={setOpen}
      size="lg"
      title={read.isSuccess ? dialogTitle(read.data, place) : "Land change"}
      description={read.isSuccess ? dialogDescription(read.data, place) : undefined}
      footer={null}
    >
      {open ? <LandBody read={read} place={place} onClose={() => setOpen(false)} /> : null}
    </Overlay>
  );

  if (read.isError)
    return {
      note: null,
      action: (
        <Button variant="outline" size={phone ? "touch" : "default"} onClick={() => setOpen(true)}>
          Land…
        </Button>
      ),
      band: null,
      dialog,
    };
  if (read.isPending) return { note: null, action: null, band: null, dialog };

  const landing = toolbarLanding({
    view: read.data,
    landedOrdinal: landedOrdinalOf(read.data, place.detail),
    currentOrdinal: place.review.checkpointB.ordinal,
    hasFiles: place.review.files.length > 0,
  });
  const button =
    landing.action === "land" || landing.action === "land-again" ? (
      <Button
        variant="outline"
        className={cn("max-lg:h-11", landing.line !== null && "@max-3xl/change:hidden")}
        onClick={() => setOpen(true)}
      >
        {landing.action === "land" ? "Land…" : "Land again…"}
      </Button>
    ) : landing.action === "landed" ? (
      <Button
        variant="ghost"
        size={phone ? "icon-touch" : "icon"}
        aria-label="What landed"
        title="What Mend observed about this change's landings"
        className="text-muted-foreground"
        onClick={() => setOpen(true)}
      >
        <GitPullRequestIcon aria-hidden />
      </Button>
    ) : null;
  return {
    note: landing.line === null ? null : <LandedLine landing={landing} />,
    action: button,
    band:
      landing.line === null ? null : (
        <div className="hidden shrink-0 flex-col gap-3 border-b px-4 py-3 text-row text-muted-foreground @max-3xl/change:flex">
          <span className="[&>span]:justify-start">
            <LandedLine landing={landing} />
          </span>
          {landing.action === "land-again" ? (
            <Button variant="outline" className="h-11 w-full" onClick={() => setOpen(true)}>
              Land again…
            </Button>
          ) : null}
        </div>
      ),
    dialog,
  };
}

/** The ordinal of the checkpoint the last push landed, from the session's checkpoints. */
const landedOrdinalOf = (view: ChangeLandingsDto, detail: SessionDetailDto): number | null => {
  const lastPush = view.landings.find((landing) => landing.pushedSha !== null);
  if (lastPush === undefined) return null;
  return detail.checkpoints.find((each) => each.id === lastPush.checkpointId)?.ordinal ?? null;
};

/** What the dialog does: land the change, update the pull request, or show what landed. */
type Mode = "land" | "update" | "observe";

const modeOf = (view: ChangeLandingsDto, place: LandPlace): Mode => {
  if (!view.land) return "observe";
  const action = toolbarLanding({
    view,
    landedOrdinal: null,
    currentOrdinal: place.review.checkpointB.ordinal,
    hasFiles: place.review.files.length > 0,
  }).action;
  if (action === "landed") return "observe";
  return view.pullRequest.available &&
    forkNote(view.landings) === null &&
    pullRequestToUpdate(view.landings) !== null
    ? "update"
    : "land";
};

const dialogTitle = (view: ChangeLandingsDto, place: LandPlace): string => {
  const mode = modeOf(view, place);
  const recorded = view.landings.find((landing) => landing.pullRequest !== null)?.pullRequest;
  if (mode === "update") return `Update pull request #${recorded?.number ?? ""}`.trim();
  if (mode === "observe")
    return recorded === undefined || recorded === null
      ? "What landed"
      : `Pull request #${recorded.number}`;
  return "Land change";
};

const dialogDescription = (view: ChangeLandingsDto, place: LandPlace): string => {
  const mode = modeOf(view, place);
  const github = view.pullRequest.available && forkNote(view.landings) === null;
  if (mode === "observe") {
    const line = toolbarLanding({
      view,
      landedOrdinal: landedOrdinalOf(view, place.detail),
      currentOrdinal: place.review.checkpointB.ordinal,
      hasFiles: place.review.files.length > 0,
    }).line;
    const owner = view.land ? "" : " Only the change's owner lands it.";
    return `${line ?? "Nothing has landed yet."}${owner}`;
  }
  if (mode === "update") {
    const recorded = pullRequestToUpdate(view.landings);
    return `Mend pushes the change as it is now to the same branch, so pull request #${recorded?.number ?? ""} picks it up. It doesn't merge the pull request.`;
  }
  return github
    ? "Mend pushes the branch to origin and opens a pull request on GitHub. It doesn't merge the pull request."
    : "Mend pushes the branch to origin.";
};

function LandBody({
  read,
  place,
  onClose,
}: {
  readonly read: UseQueryResult<ChangeLandingsDto, unknown>;
  readonly place: LandPlace;
  readonly onClose: () => void;
}) {
  if (read.isPending)
    return (
      <p role="status" className="text-row text-muted-foreground">
        Reading what landed…
      </p>
    );
  if (read.isError)
    return (
      <QueryError error={read.error} retry={() => void read.refetch()} retrying={read.isFetching} />
    );
  return <LandForm view={read.data} place={place} onClose={onClose} />;
}

/** A stored draft, read back; anything else is an empty one. */
interface LandDraft {
  /** Null while the title is as Mend would write it. */
  readonly title: string | null;
  readonly body: string;
}

const parseLandDraft = (stored: string): LandDraft => {
  if (stored === "") return { title: null, body: "" };
  try {
    const value: unknown = JSON.parse(stored);
    if (typeof value === "object" && value !== null && "title" in value && "body" in value) {
      const { title, body } = value;
      if ((typeof title === "string" || title === null) && typeof body === "string")
        return { title, body };
    }
  } catch {
    // A draft that no longer parses is no draft.
  }
  return { title: null, body: "" };
};

/** The title and description, kept as a draft so closing the dialog or a reload keeps them. */
const useLandDraft = (key: string) => {
  const stored = useSyncExternalStore(
    subscribeDrafts,
    () => readDraft(key),
    () => "",
  );
  const draft = parseLandDraft(stored);
  return {
    draft,
    setDraft: (next: LandDraft) =>
      writeDraft(key, next.title === null && next.body === "" ? "" : JSON.stringify(next)),
    clear: () => writeDraft(key, ""),
  };
};

const errorWords = (cause: unknown): string =>
  failureWords(cause, "Mend didn't answer. Try again.");

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground max-lg:mt-1">{label}</dt>
      <dd className="min-w-0 wrap-anywhere">{children}</dd>
    </>
  );
}

function LandForm({
  view,
  place,
  onClose,
}: {
  readonly view: ChangeLandingsDto;
  readonly place: LandPlace;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const ids = useId();
  const viewer = useSuspenseQuery(signedInOptions(trpc)).data;
  const project = useQuery(
    trpc.projects.detail.queryOptions({ id: place.detail.session.projectId }),
  );
  const tour = useQuery(trpc.changes.tour.queryOptions({ id: place.changeId }));
  const { draft, setDraft, clear } = useLandDraft(`land.${viewer.userId}.${place.changeId}`);
  const [showing, setShowing] = useState<"write" | "preview">("write");
  const [probed, setProbed] = useState<ChangeLandingsDto | null>(null);

  const refreshAll = () =>
    Promise.all([
      queryClient.invalidateQueries(trpc.landings.pathFilter()),
      queryClient.invalidateQueries(trpc.sessions.detail.pathFilter()),
    ]);
  const land = useMutation(
    trpc.landings.land.mutationOptions({
      onSuccess: (report) => {
        const done = landedSentence(report);
        if (done === null) return;
        clear();
        toast.add({ description: done, priority: "low" });
        onClose();
      },
      onSettled: () => void refreshAll(),
    }),
  );
  const probe = useMutation({
    mutationFn: () => probeLandings(place.changeId),
    onSuccess: setProbed,
  });
  const check = useMutation(
    trpc.landings.checkGitHub.mutationOptions({ onSettled: () => void refreshAll() }),
  );
  const refresh = useMutation(
    trpc.landings.refresh.mutationOptions({ onSettled: () => void refreshAll() }),
  );
  const observing = probe.isPending || check.isPending || refresh.isPending;

  const mode = modeOf(view, place);
  const now = new Date();
  const facts = factsWithProbe(view.facts, probed);
  const fork = forkNote(view.landings);
  const github = view.pullRequest.available && fork === null;
  const updates = pullRequestToUpdate(view.landings);
  const recorded = view.landings.find((landing) => landing.pullRequest !== null) ?? null;
  const branch = nextRemoteBranch(view, place.detail.session.branch);
  // Until the project reads (or if it can't), the dialog says "origin" and the session's base.
  const known = project.isPending || project.isError ? null : project.data.project;
  const origin = known === null ? "origin" : originPlace(known.originUrl);
  const base =
    known === null
      ? (place.detail.session.baseRef ?? "the base")
      : landingBase(place.detail.session.baseRef, known.defaultBranch);
  const startTitle =
    updates?.title ??
    defaultPullRequestTitle({ label: place.detail.session.label, id: place.detail.session.id });
  const title = draft.title ?? startTitle;
  const body = mode === "update" ? "" : draft.body;
  const editing = stillEditing(place.sessions, place.detail.session.id, viewer.userId);
  // What a landing just did wins over the record, which a re-read brings up to date.
  const problem = land.isSuccess
    ? reportProblem(land.data, view.pullRequest.available)
    : landingProblem(view.landings[0], view.pullRequest.available);
  const files = place.review.files;
  const added = files.reduce((sum, file) => sum + file.additions, 0);
  const removed = files.reduce((sum, file) => sum + file.deletions, 0);
  const moved = facts.find((fact) => fact._tag === "changed-since-landing");
  const label = landButtonLabel({
    pullRequestAvailable: view.pullRequest.available,
    updates: updates !== null,
    fork: fork !== null,
  });
  const touch = phone ? "touch" : "default";

  const preview = (ownerText: string) =>
    descriptionPreview({
      ownerText,
      media: view.media ?? [],
      // No tour read yet reads as no summary, as the landing itself would write it.
      tour: tour.isPending || tour.isError ? null : tour.data,
      files: files.map(describedFileOfReview),
      webOrigin: window.location.origin,
      sessionId: place.detail.session.id,
      changeId: place.changeId,
    });

  const submit = () => {
    if (land.isPending) return;
    // What origin held before this landing no longer describes it.
    setProbed(null);
    land.mutate({
      id: place.detail.session.id,
      request: landRequestOf({ title, body, startTitle }),
    });
  };

  const observed =
    view.landings.length > 0 || probed !== null ? (
      <Row label="Observed">
        <div className="flex flex-col gap-1">
          {facts.length === 0 ? (
            <p className="font-mono text-2xs text-muted-foreground">nothing pushed from Mend yet</p>
          ) : (
            facts.map((fact) => (
              <p
                key={JSON.stringify(fact)}
                className={cn(
                  "flex items-baseline gap-2 font-mono text-2xs",
                  factTone(fact) === "failure" ? "text-destructive" : "text-foreground",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "relative -top-px inline-block size-1.5 shrink-0 rounded-full",
                    factTone(fact) === "observed"
                      ? "bg-success"
                      : factTone(fact) === "failure"
                        ? "bg-destructive"
                        : "border border-muted-foreground",
                  )}
                />
                {factLine(fact, now)}
              </p>
            ))
          )}
          {probed === null ? null : (
            <p className="font-mono text-2xs text-muted-foreground">{remoteLine(probed, now)}</p>
          )}
          {check.isSuccess ? (
            <p role="status" className="font-mono text-2xs text-muted-foreground">
              {checkLine(check.data)}
            </p>
          ) : null}
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            <Button
              variant="link"
              size="sm"
              disabled={observing}
              title="Fetch origin's branch with your git access and compare it with the landed commit"
              onClick={() => probe.mutate()}
            >
              {probe.isPending ? "Checking origin…" : "Check origin"}
            </Button>
            {view.land && view.pullRequest.available ? (
              <Button
                variant="link"
                size="sm"
                disabled={observing}
                title="Ask GitHub, as you, for a pull request someone opened outside Mend for this change"
                onClick={() => check.mutate({ id: place.changeId })}
              >
                {check.isPending ? "Checking GitHub…" : "Check GitHub"}
              </Button>
            ) : null}
            {view.land && recorded !== null ? (
              <Button
                variant="link"
                size="sm"
                disabled={observing}
                title="Ask GitHub for the pull request's state now; Mend doesn't poll it"
                onClick={() => refresh.mutate({ id: recorded.id })}
              >
                {refresh.isPending ? "Asking GitHub…" : "Refresh pull request"}
              </Button>
            ) : null}
          </div>
          {probe.isError || check.isError || refresh.isError ? (
            <p role="alert" className="text-row text-destructive">
              {errorWords(probe.error ?? check.error ?? refresh.error)}
            </p>
          ) : null}
        </div>
      </Row>
    ) : null;

  return (
    <form
      id={`${ids}-form`}
      className="flex min-w-0 flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {problem === null || mode === "observe" ? null : (
        <section aria-labelledby={`${ids}-problem`} className="flex flex-col gap-2">
          <h3 id={`${ids}-problem`} className="text-lead font-semibold text-destructive">
            {problem.heading}
          </h3>
          <pre className="overflow-x-auto rounded-lg bg-muted px-3.5 py-2.5 font-mono text-2xs leading-relaxed whitespace-pre-wrap">
            {problem.words}
          </pre>
          <p className="text-row text-muted-foreground">{problem.next}</p>
        </section>
      )}
      {land.isError ? (
        <InlineAlert size={touch} title="Mend didn't land the change.">
          {errorWords(land.error)}
        </InlineAlert>
      ) : null}

      <dl className="grid grid-cols-[150px_minmax(0,1fr)] gap-x-6 gap-y-2.5 text-row max-lg:grid-cols-1 max-lg:gap-y-1">
        {mode === "observe" ? (
          recorded?.pushedSha == null ? null : (
            <Row label="Pushed">
              <code className="font-mono text-meta">{recorded.remoteBranch}</code> to{" "}
              <code className="font-mono text-meta">{origin}</code>
            </Row>
          )
        ) : (
          <Row label="Push">
            <code className="font-mono text-meta">{branch}</code> to{" "}
            <code className="font-mono text-meta">{origin}</code>
          </Row>
        )}
        {recorded?.pullRequest == null || mode === "land" ? null : (
          <Row label="Pull request">
            <a
              href={recorded.pullRequest.url}
              target="_blank"
              rel="noreferrer"
              className="text-info hover:underline"
            >
              #{recorded.pullRequest.number}
            </a>{" "}
            · <span className="capitalize">{recorded.pullRequest.state}</span>
          </Row>
        )}
        {mode !== "land" ? null : github ? (
          <Row label="Pull request base">
            <code className="font-mono text-meta">{base}</code>
          </Row>
        ) : (
          <Row label="Pull request">{fork ?? unavailableWords(view.pullRequest.reason)}</Row>
        )}
        {mode === "land" ? (
          <Row label="Change">
            The whole change from <code className="font-mono text-meta">{base}</code> to{" "}
            {editing.length > 0 ? "now" : `checkpoint ${place.review.checkpointB.ordinal}`}, with{" "}
            <span className="font-mono text-meta text-success">+{added}</span>{" "}
            <span className="font-mono text-meta text-destructive">−{removed}</span> in{" "}
            {files.length === 1 ? "1 file" : `${files.length} files`}
          </Row>
        ) : null}
        {mode === "update" && moved?._tag === "changed-since-landing" ? (
          <Row label="New since landing">
            {moved.files === 1 ? "1 file changed" : `${moved.files} files changed`} by checkpoint{" "}
            {place.review.checkpointB.ordinal}
          </Row>
        ) : null}
        {observed}
      </dl>

      {mode === "observe"
        ? null
        : editing.map((each) => (
            <section
              key={each.sessionId}
              className="flex flex-col gap-1 border-t pt-4"
              aria-label={each.heading}
            >
              <h3 className="text-lead font-semibold">{each.heading}</h3>
              <p className="text-row text-muted-foreground">{each.body}</p>
            </section>
          ))}

      {mode !== "observe" && heldBack(facts) ? (
        <p className="border-l-2 border-info pl-3 text-row">
          A completed turn left changes that Mend didn't land. Landing now pushes them as you.
        </p>
      ) : null}

      {mode === "observe" || !github ? null : (
        <div className="flex flex-col gap-4 border-t pt-4">
          <Field>
            <FieldLabel htmlFor={`${ids}-title`}>Pull request title</FieldLabel>
            <Input
              id={`${ids}-title`}
              value={title}
              disabled={land.isPending}
              className={phone ? "h-11" : undefined}
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            />
            {mode === "update" ? (
              <FieldDescription>
                The title as GitHub last showed it. Mend keeps it unless you change it here.
              </FieldDescription>
            ) : null}
          </Field>
          {mode === "update" ? (
            <p className="flex gap-2.5 border-t pt-4 text-row text-muted-foreground">
              <GitPullRequestIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
              Mend replaces only its own section of the pull request description, with the summary
              and files as they are when it lands. Text people wrote on GitHub stays as it is.
            </p>
          ) : (
            <Field>
              <div className="flex items-center justify-between gap-3">
                <FieldLabel htmlFor={`${ids}-body`}>Description</FieldLabel>
                <ToggleGroup
                  aria-label="Description"
                  value={[showing]}
                  onValueChange={(value: ReadonlyArray<unknown>) => {
                    const next = value[0];
                    if (next === "write" || next === "preview") setShowing(next);
                  }}
                  spacing={0.5}
                  className="shrink-0 rounded-lg bg-muted p-0.5"
                >
                  {(["write", "preview"] as const).map((value) => (
                    <ToggleGroupItem
                      key={value}
                      value={value}
                      size="sm"
                      className="h-[26px] rounded-md px-2.5 text-meta font-medium text-muted-foreground hover:bg-transparent aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-[0_0_0_1px_var(--color-input)] max-lg:h-9"
                    >
                      {value === "write" ? "Write" : "Preview"}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
              {showing === "write" ? (
                <>
                  <Textarea
                    id={`${ids}-body`}
                    value={body}
                    rows={3}
                    disabled={land.isPending}
                    placeholder="Optional. Why the change was made, for the people who review it."
                    onChange={(event) => setDraft({ ...draft, body: event.target.value })}
                  />
                  <FieldDescription>
                    Mend adds its own section under your text: the summary, the approach, the
                    changed files and links back to this session. Preview shows the whole
                    description. You can use Markdown.
                  </FieldDescription>
                </>
              ) : (
                <section
                  aria-label="Description preview"
                  className="flex max-h-96 flex-col gap-3 overflow-y-auto rounded-lg border px-5 py-4"
                >
                  {body.trim() === "" ? null : (
                    <>
                      <RichText text={body} />
                      <hr className="border-border" />
                    </>
                  )}
                  <RichText text={preview("")} />
                </section>
              )}
            </Field>
          )}
        </div>
      )}

      <div
        className={cn(
          "flex justify-end gap-2.5 pt-1",
          phone && "sticky bottom-0 -mx-5 border-t bg-popover px-5 pt-3 pb-1 *:flex-1",
        )}
      >
        {mode === "observe" ? (
          <>
            {recorded?.pullRequest == null ? null : (
              <a
                href={recorded.pullRequest.url}
                target="_blank"
                rel="noreferrer"
                className={buttonVariants({ variant: "outline", size: touch })}
              >
                Open on GitHub
              </a>
            )}
            <Button type="button" size={touch} onClick={onClose}>
              Close
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              size={touch}
              disabled={land.isPending}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" size={touch} disabled={land.isPending}>
              {land.isPending ? "Pushing…" : problem === null ? label : "Try again"}
            </Button>
          </>
        )}
      </div>
    </form>
  );
}
