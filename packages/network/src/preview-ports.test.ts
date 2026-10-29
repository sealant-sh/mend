import { describe, expect, it } from "vitest";

import {
  DEFAULT_TAILNET_PREVIEW_PORTS,
  readPreviewPorts,
  writePreviewPorts,
} from "./preview-ports.ts";

const ports = (raw: string) => {
  const read = readPreviewPorts(raw);
  return read._tag === "Ports" ? read.ports : read.problem;
};

describe("a tailnet preview port set", () => {
  it("defaults to sixteen ports from 20001", () => {
    expect(ports(DEFAULT_TAILNET_PREVIEW_PORTS)).toEqual(
      Array.from({ length: 16 }, (_, index) => 20001 + index),
    );
  });

  it("reads ports and ranges, and writes them back as short as they go", () => {
    expect(ports("20001, 20003,20010-20012")).toEqual([20001, 20003, 20010, 20011, 20012]);
    expect(writePreviewPorts([20001, 20003, 20010, 20011, 20012])).toBe("20001,20003,20010-20012");
    expect(writePreviewPorts(Array.from({ length: 16 }, (_, index) => 20001 + index))).toBe(
      DEFAULT_TAILNET_PREVIEW_PORTS,
    );
    expect(ports("443")).toEqual([443]);
  });

  it("refuses the port=previewId form with what changed", () => {
    expect(ports("20001=pv_0123")).toContain(
      "pairs a port with a preview, the form before Mend assigned ports itself",
    );
  });

  it.each([
    ["0", "is not a TCP port"],
    ["65536", "is not a TCP port"],
    ["20010-20001", "is not a TCP port (1 to 65535) or an ascending range"],
    ["20001-20002-20003", "is not a TCP port"],
    ["20001,20001", "port 20001 is listed twice"],
    ["20002,20001", "comes after 20002"],
    ["1-1001", "lists more than 1000 ports"],
    ["", "is not a TCP port"],
  ])("refuses %s", (raw, problem) => {
    expect(ports(raw)).toContain(problem);
  });
});
