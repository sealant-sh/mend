import { Button, buttonVariants } from "@mend/ui/components/ui/button";
import { cn } from "@mend/ui/lib/utils";
import { AppWindowIcon, ExternalLinkIcon, LockIcon, RotateCwIcon } from "lucide-react";
import { useId, useState } from "react";

import { joinPath, type PreviewShowing } from "#/lib/previews";

/**
 * How the view lays itself out in its tile (Doop "Preview · this workspace's services", its phone
 * copy, T13): the services beside the page in a large tile, a picker over it in a narrow one or on
 * a phone, and the page alone under its address bar in a short one.
 */
export type Layout = "list" | "picker" | "alone";

const LINK_WHY: Record<Extract<PreviewShowing, { _tag: "Link" }>["why"], (name: string) => string> =
  {
    "another-site": () =>
      "Previews are on a different site from this page, and a browser doesn't keep a preview signed in inside another site's page. Open it in a new tab: Mend signs you in to it there.",
    "own-address": (name) =>
      `${name} opens at its own address, which Mend doesn't show inside the view. Open it in a new tab.`,
  };

/**
 * The page, under its address bar: reload, the path, open in a new tab. The address is the
 * Service's and the path typed here: a page on another site can't be read from this one, so a
 * link followed inside the frame doesn't change it.
 *
 * The frame's `sandbox`, flag by flag. `allow-scripts`, `allow-forms` and `allow-modals`: the app
 * runs, submits its forms and shows its dialogs. `allow-same-origin`: the app keeps its own
 * origin, so its sign-in cookie and storage work. That origin is a preview host, never Mend's, so
 * together with `allow-scripts` it reaches nothing of Mend's: not its cookies, its storage or
 * this page. `allow-popups`: links that open a tab of their own still open, sandboxed alike. No
 * `allow-top-navigation`, so the app cannot take this tab away from Mend.
 */
export function Page({
  base,
  name,
  port,
  showing,
  layout,
  line,
}: {
  readonly base: string;
  /** The Service's name, and its port as the bar writes it (":3000"). */
  readonly name: string;
  readonly port: string;
  readonly showing: PreviewShowing;
  readonly layout: Layout;
  /** The preview's newest status line ("preview · web · answered HTTP 200 · observed 4 s ago"). */
  readonly line: string | null;
}) {
  const [path, setPath] = useState("/");
  const [shown, setShown] = useState("/");
  const [reload, setReload] = useState(0);
  const src = joinPath(base, shown);
  const id = useId();
  const signedIn = base.startsWith("/");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={cn(
          "flex shrink-0 items-center gap-1.5 border-b",
          layout === "picker" ? "px-4 py-2" : "px-3 py-2",
        )}
      >
        {showing._tag === "Frame" ? (
          <Button
            variant="ghost"
            size={layout === "picker" ? "icon-touch" : "icon-sm"}
            aria-label="Reload"
            title="Reload"
            onClick={() => setReload((count) => count + 1)}
          >
            <RotateCwIcon />
          </Button>
        ) : null}
        <form
          className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg bg-muted px-2.5 max-lg:h-11"
          onSubmit={(event) => {
            event.preventDefault();
            setShown(path);
            setReload((count) => count + 1);
          }}
        >
          {signedIn ? (
            <LockIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <AppWindowIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <label htmlFor={id} className="shrink-0 font-mono text-meta text-muted-foreground">
            {name}
            {port}
          </label>
          <input
            id={id}
            value={path}
            spellCheck={false}
            autoComplete="off"
            aria-label={`Path on ${name}`}
            onChange={(event) => setPath(event.target.value)}
            className="min-w-0 flex-1 bg-transparent font-mono text-meta text-foreground outline-none"
          />
        </form>
        {/* Where the page can't show here, the Open below says why; the bar needs none. */}
        {showing._tag === "Frame" ? (
          <a
            href={src}
            target="_blank"
            rel="noreferrer"
            aria-label="Open in a new tab"
            title="Open in a new tab"
            className={cn(
              buttonVariants({
                variant: layout === "list" ? "outline" : "ghost",
                size: layout === "list" ? "sm" : layout === "picker" ? "icon-touch" : "icon-sm",
              }),
            )}
          >
            {layout === "list" ? "Open in new tab" : <ExternalLinkIcon />}
          </a>
        ) : null}
      </div>
      {showing._tag === "Frame" ? (
        <div
          className={cn(
            "flex min-h-0 flex-1 bg-muted/40",
            layout === "alone" ? "" : "p-4 max-lg:p-3",
          )}
        >
          <iframe
            key={`${src}:${reload}`}
            title={`Preview of ${name}`}
            src={src}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            referrerPolicy="no-referrer"
            className={cn(
              "min-h-0 w-full flex-1 border-0 bg-white",
              layout !== "alone" && "rounded-xl border",
            )}
          />
        </div>
      ) : (
        <div className="flex flex-col items-start gap-3 px-6 py-6 max-lg:px-4">
          {line === null ? null : (
            <p className="font-mono text-meta break-words text-muted-foreground">{line}</p>
          )}
          <p className="max-w-prose text-row">{LINK_WHY[showing.why](name)}</p>
          <a
            href={src}
            target="_blank"
            rel="noreferrer"
            className={cn(buttonVariants({ size: layout === "picker" ? "touch" : "sm" }))}
          >
            <ExternalLinkIcon aria-hidden />
            Open in a new tab
          </a>
        </div>
      )}
    </div>
  );
}
