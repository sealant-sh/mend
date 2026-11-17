import { forwardRef, useRef, type ComponentProps } from "react";

import { Button } from "./button";

/**
 * A button that opens the browser's file picker. The real `<input type="file">` stays hidden and
 * out of the tab order; the button is what the keyboard reaches, so Enter or Space opens the
 * picker. The input is cleared after each pick, so picking the same file again still reports it.
 *
 * ```tsx
 * <FileButton multiple onFiles={(files) => stage(files)}>Add files…</FileButton>
 * ```
 */
export const FileButton = forwardRef<
  HTMLButtonElement,
  Omit<ComponentProps<typeof Button>, "onClick"> & {
    readonly onFiles: (files: ReadonlyArray<File>) => void;
    readonly multiple?: boolean;
    readonly accept?: string;
  }
>(function FileButton({ onFiles, multiple = false, accept, children, ...props }, ref) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button ref={ref} {...props} onClick={() => input.current?.click()}>
        {children}
      </Button>
      <input
        ref={input}
        type="file"
        tabIndex={-1}
        aria-hidden="true"
        className="hidden"
        multiple={multiple}
        {...(accept === undefined ? {} : { accept })}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />
    </>
  );
});
