import { InlineAlert } from "@mend/ui/components/banner";
import { Button } from "@mend/ui/components/ui/button";
import { Checkbox } from "@mend/ui/components/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldLabel } from "@mend/ui/components/ui/field";
import { Input } from "@mend/ui/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@mend/ui/components/ui/native-select";
import { cn } from "@mend/ui/lib/utils";
import { useId, useState } from "react";

import { Overlay } from "#/components/projects/overlay";
import { usePhone } from "#/lib/phone";

export interface CommandStart {
  readonly command: string;
  readonly port: number;
  readonly name: string | null;
  readonly browserScheme: "http" | "https" | null;
  readonly udp: boolean;
}
/**
 * Run a command as a Service in this workspace, or adopt a port something already listens on:
 * one-off, nothing saved. What every session starts with comes from `.mend/mend.toml` (decision
 * D8), so the dialog says where to declare it for good.
 */
export function RunCommandDialog({
  open,
  onOpenChange,
  pending,
  failure,
  onRun,
  sessions,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly pending: boolean;
  readonly failure: string | null;
  readonly onRun: (start: CommandStart) => void;
  readonly sessions: number;
}) {
  const ids = useId();
  const phone = usePhone();
  const touch = phone ? "touch" : "default";
  const [command, setCommand] = useState("");
  const [port, setPort] = useState("");
  const [name, setName] = useState("");
  const [scheme, setScheme] = useState<"" | "http" | "https">("http");
  const [udp, setUdp] = useState(false);
  const [tried, setTried] = useState(false);
  const portNumber = Number(port.trim());
  const portProblem =
    !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535
      ? "Enter the port it listens on, between 1 and 65535."
      : null;
  const submit = () => {
    setTried(true);
    if (portProblem !== null || pending) return;
    onRun({
      command: command.trim(),
      port: portNumber,
      name: name.trim() === "" ? null : name.trim(),
      browserScheme: scheme === "" ? null : scheme,
      udp,
    });
  };
  return (
    <Overlay
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setTried(false);
      }}
      title="Run a command"
      description={
        <>
          It runs in this workspace until it stops
          {sessions > 1 ? ", and every session here can use it" : ""}. To start it with every
          session, declare it in <span className="font-mono">.mend/mend.toml</span>.
        </>
      }
      size="md"
      footer={
        <>
          <Button variant="outline" size={touch} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form={`${ids}-form`} size={touch} disabled={pending}>
            {pending ? "Starting…" : command.trim() === "" ? "Adopt port" : "Run"}
          </Button>
        </>
      }
    >
      <form
        id={`${ids}-form`}
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field>
          <FieldLabel htmlFor={`${ids}-command`}>Command</FieldLabel>
          <Input
            id={`${ids}-command`}
            value={command}
            autoComplete="off"
            spellCheck={false}
            placeholder="pnpm dev"
            className={cn("font-mono", phone && "h-11")}
            onChange={(event) => setCommand(event.target.value)}
          />
          <FieldDescription>
            Leave it empty to adopt a port something in the workspace already listens on.
          </FieldDescription>
        </Field>
        <div className="flex gap-3 max-sm:flex-col">
          <Field data-invalid={tried && portProblem !== null ? true : undefined}>
            <FieldLabel htmlFor={`${ids}-port`}>Port</FieldLabel>
            <Input
              id={`${ids}-port`}
              value={port}
              inputMode="numeric"
              autoComplete="off"
              placeholder="3000"
              aria-invalid={tried && portProblem !== null ? true : undefined}
              className={cn("font-mono", phone && "h-11")}
              onChange={(event) => setPort(event.target.value)}
            />
            {tried && portProblem !== null ? <FieldError>{portProblem}</FieldError> : null}
          </Field>
          <Field>
            <FieldLabel htmlFor={`${ids}-name`}>Name</FieldLabel>
            <Input
              id={`${ids}-name`}
              value={name}
              autoComplete="off"
              spellCheck={false}
              placeholder="web"
              className={cn("font-mono", phone && "h-11")}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor={`${ids}-scheme`}>Opens in a browser</FieldLabel>
          <NativeSelect
            id={`${ids}-scheme`}
            value={udp ? "" : scheme}
            disabled={udp}
            className={phone ? "h-11" : undefined}
            onChange={(event) => {
              const value = event.target.value;
              setScheme(value === "http" || value === "https" ? value : "");
            }}
          >
            <NativeSelectOption value="http">Yes, over http</NativeSelectOption>
            <NativeSelectOption value="https">Yes, over https</NativeSelectOption>
            <NativeSelectOption value="">No, it isn't a web page</NativeSelectOption>
          </NativeSelect>
        </Field>
        <Field orientation="horizontal">
          <Checkbox
            id={`${ids}-udp`}
            checked={udp}
            onCheckedChange={(checked) => setUdp(checked)}
          />
          <FieldLabel htmlFor={`${ids}-udp`} className="font-normal">
            It speaks UDP
          </FieldLabel>
        </Field>
        {failure === null ? null : (
          <InlineAlert size={touch} title="It didn't start.">
            {failure}
          </InlineAlert>
        )}
      </form>
    </Overlay>
  );
}

/** The Preview view (ADR 0026): this workspace's services, and the page one of them serves. */
