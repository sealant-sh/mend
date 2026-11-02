import { cn } from "@mend/ui/lib/utils";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { Icon, type IconName } from "./icons";

/** The visible keyboard focus every kit control shares. */
export const focusRing =
  "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sw-accent)]";

const BUTTON = {
  default:
    "border-input bg-panel text-foreground shadow-xs hover:-translate-y-px hover:shadow-sm active:translate-y-0",
  primary:
    "border-primary bg-primary text-primary-foreground shadow-cobalt hover:bg-[var(--primary-hover)] hover:border-[var(--primary-hover)]",
  ghost: "border-transparent bg-transparent text-ink-2 shadow-none hover:bg-secondary",
} as const;

export type ButtonVariant = keyof typeof BUTTON;

/** `.btn`: one filled cobalt action per view, quieter ones outlined or ghost (DESIGN.md §5). */
export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    readonly variant?: ButtonVariant;
    readonly size?: "default" | "sm";
  }
>(function Button({ variant = "default", size = "default", className, type, ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(
        "inline-flex items-center gap-1.5 border font-sans font-medium whitespace-nowrap transition-[translate,box-shadow,background-color] duration-150 disabled:pointer-events-none disabled:opacity-50",
        size === "sm"
          ? "rounded-[10px] px-2.5 py-1.5 text-[12.5px] leading-none"
          : "rounded-xl px-3.5 py-[9px] text-[13px] leading-none",
        BUTTON[variant],
        focusRing,
        className,
      )}
      {...props}
    />
  );
});

/**
 * `.ib`: a square icon button. `label` is its accessible name and its hover title, since the
 * icon alone says nothing to a screen reader.
 */
export const IconButton = forwardRef<
  HTMLButtonElement,
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
    readonly icon: IconName;
    readonly label: string;
    readonly bordered?: boolean;
    readonly size?: "default" | "sm";
    readonly active?: boolean;
  }
>(function IconButton(
  { icon, label, bordered = false, size = "default", active = false, className, type, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      aria-label={label}
      title={label}
      className={cn(
        "grid shrink-0 place-items-center border transition-colors duration-150 disabled:opacity-50",
        size === "sm" ? "size-6 rounded-[7px]" : "size-[30px] rounded-[9px]",
        active
          ? "border-transparent bg-wash text-info"
          : bordered
            ? "border-rule bg-panel text-ink-2 shadow-xs hover:text-foreground"
            : "border-transparent text-muted-foreground hover:bg-secondary hover:text-foreground",
        focusRing,
        className,
      )}
      {...props}
    >
      <Icon name={icon} size={size === "sm" ? 13 : 15} />
    </button>
  );
});

/** `.pick`: a small picker chip that opens a menu; `active` takes the cobalt wash. */
export const Pick = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    readonly active?: boolean;
    readonly chevron?: boolean;
    readonly size?: "default" | "sm";
  }
>(function Pick(
  { active = false, chevron = true, size = "default", className, children, type, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[9px] border font-sans font-medium whitespace-nowrap transition-colors duration-150 disabled:opacity-50",
        size === "sm"
          ? "px-[9px] py-1 text-[12px] leading-[1.3]"
          : "px-2.5 py-[5px] text-[12.5px] leading-[1.3]",
        active
          ? "border-transparent bg-wash text-info"
          : "border-rule text-ink-2 hover:bg-secondary hover:text-foreground",
        focusRing,
        className,
      )}
      {...props}
    >
      {children}
      {chevron ? <Chevron /> : null}
    </button>
  );
});

/** The small down chevron a picker carries. */
export function Chevron({ className }: { readonly className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "ml-0.5 inline-block size-[5px] translate-y-[-2px] rotate-45 border-r-[1.5px] border-b-[1.5px] border-faint",
        className,
      )}
    />
  );
}

/** `.kbd`: a key hint. */
export function Kbd({ children }: { readonly children: ReactNode }) {
  return (
    <kbd className="rounded-[5px] border border-rule px-[5px] py-0.5 font-mono text-[10.5px] leading-none font-medium text-faint">
      {children}
    </kbd>
  );
}

/** `.eb`: the tiny mono eyebrow, the only uppercase text (DESIGN.md §2). */
export function Eyebrow({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <p
      className={cn(
        "font-mono text-[10.5px] leading-[1.3] font-medium tracking-[0.06em] text-label uppercase",
        className,
      )}
    >
      {children}
    </p>
  );
}
