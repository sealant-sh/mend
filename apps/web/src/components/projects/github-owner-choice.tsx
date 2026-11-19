import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@mend/ui/components/ui/select";
import { cn } from "@mend/ui/lib/utils";

/** One account whose repositories the picker can list, as `github.owners` answers it. */
export interface GithubOwner {
  readonly login: string;
  readonly kind: "user" | "organization";
}

/**
 * Whose repositories the picker lists, above the list in First project and Add project: the
 * person's own GitHub account first, then each organization it belongs to, by name.
 */
export function GithubOwnerChoice({
  owners,
  value,
  onChange,
  phone,
}: {
  readonly owners: ReadonlyArray<GithubOwner>;
  readonly value: string;
  readonly onChange: (owner: string) => void;
  readonly phone: boolean;
}) {
  const kindOf = (login: string) =>
    owners.find((owner) => owner.login === login)?.kind === "organization"
      ? "Organization"
      : "Your account";
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (typeof next === "string" && next !== value) onChange(next);
      }}
    >
      <SelectTrigger
        aria-label="Whose repositories"
        className={cn("w-full font-mono text-meta", phone ? "h-11" : "h-9")}
      >
        <SelectValue>{(login: string) => login}</SelectValue>
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false}>
        <SelectGroup>
          <SelectLabel>Whose repositories</SelectLabel>
          {owners.map((owner) => (
            <SelectItem key={owner.login} value={owner.login}>
              <span className="flex flex-1 items-center justify-between gap-6">
                <span className="font-mono text-meta">{owner.login}</span>
                <span className="text-meta text-muted-foreground">{kindOf(owner.login)}</span>
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
