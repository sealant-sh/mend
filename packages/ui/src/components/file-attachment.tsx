import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@mend/ui/components/ui/attachment";
import { cn } from "@mend/ui/lib/utils";
import { FileTextIcon } from "lucide-react";
import * as React from "react";

/**
 * A file the person attached to a message: a file icon, the name in mono and its size. It sits
 * above the message bubble. `layout="row"` puts the size beside the name, as the phone composer
 * does; a long name shortens with an ellipsis, never the size.
 */
function FileAttachment({
  name,
  fileSize,
  layout = "stacked",
  icon,
  className,
  ...props
}: Omit<React.ComponentProps<typeof Attachment>, "children" | "size"> & {
  name: string;
  fileSize?: string;
  layout?: "stacked" | "row";
  icon?: React.ReactNode;
}) {
  return (
    <Attachment
      data-slot="file-attachment"
      data-layout={layout}
      className={cn(
        "group/file-attachment max-w-80 min-w-0 gap-2.5 rounded-pop border-border bg-background has-data-[slot=attachment-content]:py-2 has-data-[slot=attachment-content]:pr-3 has-data-[slot=attachment-content]:pl-2",
        className,
      )}
      {...props}
    >
      <AttachmentMedia className="size-8 rounded-chip text-muted-foreground">
        {icon ?? <FileTextIcon />}
      </AttachmentMedia>
      <AttachmentContent className="grid items-baseline gap-x-2 gap-y-px leading-snug group-data-[layout=row]/file-attachment:grid-cols-[minmax(0,1fr)_auto]">
        <AttachmentTitle className="font-mono text-meta font-normal">{name}</AttachmentTitle>
        {fileSize === undefined ? null : (
          <AttachmentDescription className="mt-0 shrink-0 text-2xs">
            {fileSize}
          </AttachmentDescription>
        )}
      </AttachmentContent>
    </Attachment>
  );
}

export { FileAttachment };
