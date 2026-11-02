import { ProjectId } from "@mend/domain";
import { describe, expect, it } from "vitest";

import { projectChoices } from "./filter-line.tsx";

const project = (name: string) => ({ id: ProjectId.make(`p-${name}`), name });

describe("the inbox's project picker", () => {
  const projects = [project("mend"), project("configs"), project("sealant-config")];

  it("matches the letters typed in order, as the kit's finders do", () => {
    expect(projectChoices(projects, "confg").map(({ choice }) => choice.name)).toEqual([
      "configs",
      "sealant-config",
    ]);
  });

  it("lists All projects and then every project while nothing is typed", () => {
    expect(projectChoices(projects, "").map(({ choice }) => choice.name)).toEqual([
      "All projects",
      "mend",
      "configs",
      "sealant-config",
    ]);
  });
});
