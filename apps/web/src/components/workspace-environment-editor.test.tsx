import { defaultSettings } from "@mend/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WorkspaceEnvironmentEditor } from "./workspace-environment-editor.tsx";

const dockerSwitch = (docker: boolean) => {
  const image = { ...defaultSettings.workspaceImage, services: { docker } };
  const markup = renderToStaticMarkup(
    <WorkspaceEnvironmentEditor
      savedImage={image}
      allowScan={false}
      onSave={() => Promise.resolve({ saved: image, resolutions: [] })}
    />,
  );
  const control = /<button[^>]*role="switch"[^>]*>/.exec(markup)?.[0] ?? "";
  const labelId = /aria-labelledby="([^"]+)"/.exec(control)?.[1] ?? "";
  return {
    checked: /aria-checked="([^"]+)"/.exec(control)?.[1],
    name: new RegExp(`id="${labelId}"[^>]*>([^<]*)<`).exec(markup)?.[1]?.trim(),
  };
};

describe("the workspace environment's Docker switch", () => {
  it("is named after what it controls, with its state in aria-checked", () => {
    expect(dockerSwitch(true)).toEqual({ checked: "true", name: "Docker service" });
    expect(dockerSwitch(false)).toEqual({ checked: "false", name: "Docker service" });
  });
});
