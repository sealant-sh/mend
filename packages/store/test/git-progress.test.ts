import { describe, expect, it } from "vitest";

import { gitProgressReader, parseGitProgress, withoutGitProgress } from "../src/git-progress.ts";

describe("git's progress, read", () => {
  it("reads a counted step with its percent", () => {
    expect(parseGitProgress("remote: Counting objects:  12% (5/41)        ")).toEqual({
      step: "Counting objects",
      remote: true,
      percent: 12,
      done: 5,
      total: 41,
      received: null,
      rate: null,
    });
  });

  it("reads what has arrived and how fast, as git prints them", () => {
    expect(
      parseGitProgress("Receiving objects:  45% (72/160), 1.20 MiB | 2.00 MiB/s"),
    ).toMatchObject({
      step: "Receiving objects",
      remote: false,
      percent: 45,
      done: 72,
      total: 160,
      received: "1.20 MiB",
      rate: "2.00 MiB/s",
    });
    expect(
      parseGitProgress("Receiving objects: 100% (160/160), 37.63 KiB | 1.21 MiB/s, done."),
    ).toMatchObject({ percent: 100, received: "37.63 KiB", rate: "1.21 MiB/s" });
  });

  it("reads a step counted without a known end", () => {
    expect(parseGitProgress("remote: Enumerating objects: 160, done.")).toMatchObject({
      step: "Enumerating objects",
      percent: null,
      done: 160,
      total: null,
    });
  });

  it.each([
    "Cloning into bare repository '/srv/mend/p/repo.git'...",
    "remote: Total 160 (delta 2), reused 0 (delta 0), pack-reused 119 (from 1)",
    "fatal: repository 'https://github.com/a/b/' not found",
    "git@github.com: Permission denied (publickey).",
  ])("reads %s as no progress", (line) => {
    expect(parseGitProgress(line)).toBeNull();
  });

  it("keeps what git said besides counting, for a failure's words", () => {
    expect(
      withoutGitProgress(
        "Cloning into bare repository 'x'...\nremote: Counting objects:  50% (1/2)\rremote: Counting objects: 100% (2/2), done.\nerror: RPC failed; curl 92 HTTP/2 stream 5 was not closed cleanly\nfatal: early EOF\n",
      ),
    ).toBe("error: RPC failed; curl 92 HTTP/2 stream 5 was not closed cleanly\nfatal: early EOF");
  });

  it("hears whole lines only, however git's output is cut", () => {
    const heard: Array<number | null> = [];
    const read = gitProgressReader((progress) => heard.push(progress.percent));
    read("Receiving objects:  1");
    read("0% (16/160)\rReceiving objects:  20% (32/160)\r");
    read("Receiving objects:  30% (48/160), 1.00 MiB | 1.00 MiB/s\n");
    expect(heard).toEqual([10, 20, 30]);
  });
});
