import type { SpeedMode } from "@mend/domain/workbench";
import type { ProviderOptionDescriptor, ProviderOptionSelection } from "@mend/t3-contracts";

/** T3 v0.1.2's service-tier picker, including its legacy Fast toggle. */
export function speedOfOptions(options: ReadonlyArray<ProviderOptionSelection>): SpeedMode | null {
  const tier = options.find((option) => option.id === "serviceTier")?.value;
  if (tier === "fast" || tier === "priority") return "fast";
  if (tier === "default" || tier === "standard") return "standard";
  if (tier !== undefined) return null;
  return options.some((option) => option.id === "fastMode" && option.value === true)
    ? "fast"
    : "standard";
}

/** Mend supports Codex's Standard and Fast tiers; the provider decides account eligibility. */
export const CODEX_SERVICE_TIER: ProviderOptionDescriptor = {
  id: "serviceTier",
  label: "Service Tier",
  type: "select",
  options: [
    { id: "default", label: "Standard", isDefault: true },
    { id: "fast", label: "Fast" },
  ],
};
