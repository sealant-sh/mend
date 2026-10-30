import { defaultWorkspaceImage, type WorkspaceImage } from "@mend/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WorkspaceEnvironmentEditor } from "./workspace-environment-editor.tsx";

const render = (image: WorkspaceImage) =>
  renderToStaticMarkup(
    <WorkspaceEnvironmentEditor
      savedImage={image}
      allowScan={false}
      onSave={() => Promise.resolve({ saved: image, resolutions: [] })}
    />,
  );

const switches = (markup: string) =>
  [...markup.matchAll(/<button[^>]*role="switch"[^>]*>/g)].map(([control]) => {
    const labelId = /aria-labelledby="([^"]+)"/.exec(control)?.[1] ?? "";
    return {
      name: new RegExp(`id="${labelId}"[^>]*>([^<]*)<`).exec(markup)?.[1]?.trim(),
      checked: /aria-checked="([^"]+)"/.exec(control)?.[1],
    };
  });

describe("the workspace environment's switches", () => {
  it("names the Docker switch after what it controls, with its state in aria-checked", () => {
    const docker = (on: boolean) =>
      switches(render({ ...defaultWorkspaceImage, services: { docker: on } })).find(
        ({ name }) => name === "Docker service",
      );
    expect(docker(true)).toEqual({ checked: "true", name: "Docker service" });
    expect(docker(false)).toEqual({ checked: "false", name: "Docker service" });
  });

  it("shows a family image's Screen switch, off by default, with what it adds and costs", () => {
    const markup = render(defaultWorkspaceImage);
    expect(switches(markup)).toContainEqual({ name: "Screen", checked: "false" });
    expect(markup).toContain(
      "Adds TigerVNC, the Openbox window manager, Chromium and DejaVu fonts",
    );
    expect(markup).toContain(
      "The image grows by an amount Mend has not measured yet. x86_64 only.",
    );
    expect(
      switches(render({ ...defaultWorkspaceImage, screen: true })).find(
        ({ name }) => name === "Screen",
      ),
    ).toEqual({ name: "Screen", checked: "true" });
  });

  it("offers no Screen switch on a custom base", () => {
    const markup = render({
      mode: "custom",
      baseImage: "node:22-bookworm",
      packages: [],
      setupCommands: [],
      services: { docker: true },
    });
    expect(switches(markup).map(({ name }) => name)).toEqual(["Docker service"]);
  });
});
