import { useSuspenseQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { Button } from "#/components/kit/button";
import { CodeBox } from "#/components/kit/code-box";
import { ModalDialog } from "#/components/kit/modal";
import { formatDay } from "#/components/pairing-qr";
import type { OrganizationViewDto } from "#/lib/api";
import { useTRPC } from "#/lib/trpc";
import { signedInOptions } from "#/lib/viewer";

/**
 * Who is looking, inside an Organization tab. The tab's route already refused anyone outside an
 * organization and warmed this read, so it is there on first render and shared by every tab.
 */
export const useOrganizationView = (): OrganizationViewDto =>
  useSuspenseQuery(signedInOptions(useTRPC())).data;

/** A date as the settings tables write it: `Nov 8, 2026`. */
export const day = (at: Date): string => formatDay(at.toISOString());

/**
 * The caption over a group control (a segment, a picker) in the field voice. The control names
 * itself with the same words, so the caption is decoration for sighted readers.
 */
export function Caption({ children }: { readonly children: ReactNode }) {
  return (
    <span aria-hidden="true" className="font-sans text-[12.5px] font-medium text-ink-2">
      {children}
    </span>
  );
}

/** A caption over its control, spaced like a `Field`. */
export function CaptionedControl({
  caption,
  children,
}: {
  readonly caption: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="mb-4 grid gap-1.5 last:mb-0">
      <Caption>{caption}</Caption>
      {children}
    </div>
  );
}

/**
 * A link that works once, shown the one time the server hands it over: an invitation, a password
 * reset. Closing the dialog drops it; nothing shows it again.
 */
export function OneTimeLinkDialog({
  link,
  title,
  description,
  onClose,
}: {
  readonly link: { readonly path: string; readonly expiresAt: Date } | null;
  readonly title: string;
  readonly description: ReactNode;
  readonly onClose: () => void;
}) {
  const url = link === null ? "" : `${window.location.origin}${link.path}`;
  return (
    <ModalDialog
      open={link !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={title}
      description={description}
      width={520}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      {link === null ? null : (
        <>
          <CodeBox copy={url} label="the link">
            {url}
          </CodeBox>
          <p className="font-mono text-[12px] text-muted-foreground">
            works once · expires {day(link.expiresAt)} · not shown again
          </p>
        </>
      )}
    </ModalDialog>
  );
}

/** A quiet line that reports what an action did beyond itself, announced politely. */
export function Notice({ children }: { readonly children: ReactNode }) {
  return (
    <p
      role="status"
      className="mt-3 border-l-2 border-warning pl-3 text-[13px] leading-relaxed text-ink-2"
    >
      {children}
    </p>
  );
}
