import { Button } from "@mend/ui/components/ui/button";
import { cn } from "@mend/ui/lib/utils";
import { ArrowUpIcon, ChevronDownIcon, LockIcon, PaperclipIcon, SquareIcon } from "lucide-react";
import * as React from "react";

type PromptInputState = "default" | "running" | "locked";

/**
 * The session composer: a floating card with the message field and a bar under it holding attach,
 * the harness's name, the model picker (`model`, which the app fills), the context used (`usage`)
 * and send.
 *
 * Enter sends and Shift+Enter starts a new line. `state`:
 * - `default`: send is off while the field is empty, unless `allowEmpty` (a picked Question
 *   choice is an answer on its own).
 * - `running`: the agent is working. Enter steers it (`onSteer`), and Stop turn (`onStop`) sits
 *   beside Steer. `stopping` keeps Stop turn off and says so while the stop is on its way.
 * - `locked`: the viewer can't message the session. Only `notice` shows, and nothing sends.
 *   `noticeAction` (a button) sits beside it, or under it at `size="touch"`: what the viewer can
 *   do instead.
 *
 * In a narrow tile the context count hides first, then the harness name. `size="touch"` gives
 * 44px targets and hides the context count; while running it also hides the harness name, so Steer
 * and Stop turn fit at 390px.
 *
 * `submitLabel` turns send into a labelled button ("Start session" in the New session composer).
 * `blocked` keeps send off whatever the field holds, for a composer that can't send yet; say why
 * beside it.
 */
function PromptInput({
  state = "default",
  size = "default",
  placeholder,
  label,
  notice,
  noticeAction,
  harness,
  model,
  usage,
  value,
  defaultValue = "",
  onValueChange,
  allowEmpty = false,
  onSubmit,
  onSteer,
  onStop,
  stopping = false,
  onAttach,
  submitLabel,
  blocked = false,
  id,
  autoFocus,
  className,
}: {
  state?: PromptInputState;
  size?: "default" | "touch";
  placeholder?: string;
  /** The field's name for screen readers; the placeholder when not given. */
  label?: string;
  notice?: React.ReactNode;
  /** While `locked`: what the viewer can do instead, a button beside the notice. */
  noticeAction?: React.ReactNode;
  harness?: string;
  model?: React.ReactNode;
  usage?: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  allowEmpty?: boolean;
  onSubmit?: (text: string) => void;
  onSteer?: (text: string) => void;
  onStop?: () => void;
  stopping?: boolean;
  onAttach?: () => void;
  submitLabel?: string;
  blocked?: boolean;
  /** The message field's id, for a label or a shortcut that focuses it. */
  id?: string;
  autoFocus?: boolean;
  className?: string;
}) {
  const [own, setOwn] = React.useState(defaultValue);
  const text = value ?? own;
  const setText = (next: string) => {
    if (value === undefined) setOwn(next);
    onValueChange?.(next);
  };
  const trimmed = text.trim();
  const running = state === "running";
  const canSend = state === "default" && !blocked && (trimmed !== "" || allowEmpty);
  const canSteer = running && !blocked && trimmed !== "";

  const send = () => {
    if (canSend) {
      onSubmit?.(trimmed);
      setText("");
    } else if (canSteer) {
      onSteer?.(trimmed);
      setText("");
    }
  };

  const touch = size === "touch";

  return (
    <form
      data-slot="prompt-input"
      data-state={state}
      data-size={size}
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
      className={cn(
        "group/prompt @container/prompt rounded-xl border border-input bg-card text-sm text-foreground shadow-card data-[state=locked]:bg-muted data-[state=locked]:shadow-none",
        className,
      )}
    >
      {state === "locked" && noticeAction === undefined ? (
        <p
          data-slot="prompt-input-notice"
          className="flex items-center gap-2 px-4 py-3.5 text-muted-foreground"
        >
          <LockIcon aria-hidden="true" className="size-4 shrink-0" />
          <span>{notice}</span>
        </p>
      ) : state === "locked" ? (
        <div
          className={cn(
            "flex",
            size === "touch"
              ? "flex-col gap-3 px-4 py-3.5"
              : "flex-wrap items-center gap-3 py-2.5 pr-2.5 pl-4",
          )}
        >
          <p
            data-slot="prompt-input-notice"
            className="flex min-w-0 flex-1 items-start gap-2 text-muted-foreground"
          >
            <LockIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{notice}</span>
          </p>
          <div
            data-slot="prompt-input-notice-action"
            className={size === "touch" ? "flex flex-col" : "shrink-0"}
          >
            {noticeAction}
          </div>
        </div>
      ) : (
        <>
          <textarea
            data-slot="prompt-input-textarea"
            id={id}
            autoFocus={autoFocus}
            aria-label={label ?? placeholder}
            placeholder={placeholder}
            value={text}
            rows={1}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              send();
            }}
            className="block field-sizing-content max-h-60 min-h-11 w-full resize-none bg-transparent pt-3.5 pr-4 pb-1 pl-4.5 text-prose leading-normal outline-none placeholder:text-faint"
          />
          <div
            data-slot="prompt-input-bar"
            className="flex items-center gap-0.5 px-2.5 pt-2 pb-2.5 group-data-[size=touch]/prompt:gap-0 group-data-[size=touch]/prompt:px-1 group-data-[size=touch]/prompt:pt-0.5 group-data-[size=touch]/prompt:pb-1 group-data-[state=running]/prompt:gap-1.5"
          >
            {onAttach === undefined ? null : (
              <Button
                type="button"
                variant="ghost"
                size={touch ? "icon-touch" : "icon"}
                aria-label="Attach a file"
                className="text-muted-foreground"
                onClick={onAttach}
              >
                <PaperclipIcon />
              </Button>
            )}
            {harness === undefined ? null : (
              <span
                data-slot="prompt-input-harness"
                className={cn(
                  "hidden ps-1.5 pe-1 text-control font-medium whitespace-nowrap opacity-85 @sm/prompt:inline",
                  // On a phone the composer is the screen's width, not a narrow tile: the name
                  // stays, except while running, when Steer and Stop turn need the room.
                  touch && (running ? "@sm/prompt:hidden" : "inline"),
                )}
              >
                {harness}
              </span>
            )}
            {model}
            <span className="flex-1" />
            {usage === undefined ? null : (
              <span
                data-slot="prompt-input-usage"
                title="Context used"
                className={cn(
                  "hidden px-2 text-meta whitespace-nowrap text-muted-foreground tabular-nums @md/prompt:inline",
                  touch && "@md/prompt:hidden",
                )}
              >
                {usage}
              </span>
            )}
            {running ? (
              <>
                <Button type="submit" disabled={!canSteer} className={cn(touch && "h-11")}>
                  Steer
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  className={cn(touch && "h-11")}
                  disabled={stopping}
                  onClick={onStop}
                >
                  <SquareIcon className="size-3" />
                  {stopping ? "Stopping…" : "Stop turn"}
                </Button>
              </>
            ) : submitLabel !== undefined ? (
              <Button
                type="submit"
                size={touch ? "touch" : "default"}
                disabled={!canSend}
                className="disabled:opacity-45"
              >
                {submitLabel}
              </Button>
            ) : (
              <Button
                type="submit"
                size={touch ? "icon-touch" : "icon"}
                aria-label="Send"
                disabled={!canSend}
                className="disabled:opacity-45"
              >
                <ArrowUpIcon />
              </Button>
            )}
          </div>
        </>
      )}
    </form>
  );
}

/**
 * The model picker's button for the prompt input's bar: the model's name and a chevron. Render it
 * as the trigger of the app's menu (`<DropdownMenuTrigger render={<PromptInputModel … />} />`).
 */
function PromptInputModel({
  size = "default",
  children,
  className,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "size" | "variant"> & {
  size?: "default" | "touch";
}) {
  return (
    <Button
      data-slot="prompt-input-model"
      type="button"
      variant="ghost"
      size={size === "touch" ? "touch" : "sm"}
      className={cn(
        "h-7.5 gap-1.25 rounded-chip px-2 text-control font-medium",
        size === "touch" && "h-11 px-3",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronDownIcon aria-hidden="true" className="size-3 text-muted-foreground" />
    </Button>
  );
}

/**
 * The one floating card at the bottom of a conversation when the agent has asked a question or
 * wants approval: the Question or Approval, a hairline, then the Prompt input, which drops its own
 * border and shadow inside the card. With nothing to answer, use the Prompt input on its own.
 */
function ComposerCard({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-card"
      className={cn(
        "mx-auto max-w-conversation overflow-hidden rounded-xl border border-input bg-card text-foreground shadow-card",
        "*:not-data-[slot=prompt-input]:border-b *:data-[slot=prompt-input]:rounded-none *:data-[slot=prompt-input]:border-0 *:data-[slot=prompt-input]:shadow-none",
        className,
      )}
      {...props}
    />
  );
}

export { ComposerCard, PromptInput, PromptInputModel, type PromptInputState };
