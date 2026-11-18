import { Autocomplete as AutocompletePrimitive } from "@base-ui/react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@mend/ui/components/ui/input-group";
import { cn } from "@mend/ui/lib/utils";
import { ChevronsUpDownIcon } from "lucide-react";
import * as React from "react";

/**
 * A text field that suggests values as you type and still takes anything typed (a branch, a tag
 * or a commit): Base UI's Autocomplete, styled as the kit's Combobox. Use Combobox when the value
 * must be one of the items.
 */
const Autocomplete = AutocompletePrimitive.Root;

function AutocompleteInput({
  className,
  disabled = false,
  showTrigger = true,
  ...props
}: AutocompletePrimitive.Input.Props & { showTrigger?: boolean }) {
  return (
    <InputGroup className={cn("w-auto", className)}>
      <AutocompletePrimitive.Input
        render={<InputGroupInput disabled={disabled} />}
        disabled={disabled}
        {...props}
      />
      {showTrigger ? (
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            variant="ghost"
            render={<AutocompletePrimitive.Trigger />}
            data-slot="input-group-button"
            className="data-pressed:bg-transparent"
            disabled={disabled}
          >
            <ChevronsUpDownIcon className="pointer-events-none size-4 text-muted-foreground" />
          </InputGroupButton>
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  );
}

function AutocompleteContent({
  className,
  side = "bottom",
  sideOffset = 6,
  align = "start",
  ...props
}: AutocompletePrimitive.Popup.Props &
  Pick<AutocompletePrimitive.Positioner.Props, "side" | "align" | "sideOffset">) {
  return (
    <AutocompletePrimitive.Portal>
      <AutocompletePrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        className="isolate z-50"
      >
        <AutocompletePrimitive.Popup
          data-slot="autocomplete-content"
          className={cn(
            "group/autocomplete-content relative max-h-(--available-height) w-(--anchor-width) max-w-(--available-width) origin-(--transform-origin) overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-pop ring-1 ring-foreground/10 duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        />
      </AutocompletePrimitive.Positioner>
    </AutocompletePrimitive.Portal>
  );
}

function AutocompleteList({ className, ...props }: AutocompletePrimitive.List.Props) {
  return (
    <AutocompletePrimitive.List
      data-slot="autocomplete-list"
      className={cn(
        "no-scrollbar max-h-[min(--spacing(72),var(--available-height))] scroll-py-1 overflow-y-auto overscroll-contain p-1 data-empty:p-0",
        className,
      )}
      {...props}
    />
  );
}

function AutocompleteItem({ className, ...props }: AutocompletePrimitive.Item.Props) {
  return (
    <AutocompletePrimitive.Item
      data-slot="autocomplete-item"
      className={cn(
        "relative flex w-full cursor-default items-center gap-2 rounded-md px-1.5 py-1 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function AutocompleteEmpty({ className, ...props }: AutocompletePrimitive.Empty.Props) {
  return (
    <AutocompletePrimitive.Empty
      data-slot="autocomplete-empty"
      className={cn("px-2.5 py-2 text-sm text-muted-foreground empty:m-0 empty:p-0", className)}
      {...props}
    />
  );
}

function AutocompleteStatus({
  className,
  ...props
}: React.ComponentProps<typeof AutocompletePrimitive.Status>) {
  return (
    <AutocompletePrimitive.Status
      data-slot="autocomplete-status"
      className={cn("px-2.5 py-2 text-sm text-muted-foreground empty:m-0 empty:p-0", className)}
      {...props}
    />
  );
}

export {
  Autocomplete,
  AutocompleteContent,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompleteStatus,
};
