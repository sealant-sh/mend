import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";

import { parseWorkspaceSshTarget, writeWorkspaceSshConfig } from "../../src/index.ts";

const [root, stage, linkArgument] = process.argv.slice(2);
assert.ok(root);
assert.ok(stage === "fsync" || stage === "chmod" || stage === "rename");
assert.ok(linkArgument === "true" || linkArgument === "false");
const linked = linkArgument === "true";
const configDirectory = path.join(root, ".ssh");
const destinationDirectory = linked ? path.join(root, "dotfiles") : configDirectory;
const configFile = path.join(configDirectory, "config");
const destination = path.join(destinationDirectory, "config");
const before = "Host unrelated\n  HostName unrelated.example.test\n  User git\n";
const injected = new Error(`synthetic ${stage} failure after temporary write`);
const parsed = parseWorkspaceSshTarget({
  serverUrl: "http://mend.example.test:3105",
  publishedPort: 2222,
});
assert.ok(parsed.ok);

fs.mkdirSync(configDirectory);
if (linked) fs.mkdirSync(destinationDirectory);
fs.writeFileSync(destination, before, { mode: 0o640 });
// Set an exact fixture mode independently of the caller's umask.
fs.chmodSync(destination, 0o640);
if (linked) fs.symlinkSync(path.relative(configDirectory, destination), configFile);
const originalInode = fs.statSync(destination).ino;

let observed;
let descriptor;
const observeTemporary = () => {
  const entries = fs.readdirSync(destinationDirectory).filter((name) => name !== "config");
  assert.equal(entries.length, 1);
  const temporary = path.join(destinationDirectory, entries[0]);
  observed = {
    contents: fs.readFileSync(temporary, "utf8"),
    inode: fs.statSync(temporary).ino,
  };
  return temporary;
};

// Inject only the selected syscall in an isolated child. The production function's
// writes, close, error translation, cleanup and retry remain real filesystem work.
const originalFsync = fs.fsyncSync;
const originalChmod = fs.chmodSync;
const originalRename = fs.renameSync;
try {
  if (stage === "fsync") {
    fs.fsyncSync = (fd) => {
      descriptor = fd;
      observeTemporary();
      assert.equal(fs.fstatSync(fd).ino, observed.inode);
      throw injected;
    };
  } else if (stage === "chmod") {
    fs.chmodSync = (file, mode) => {
      if (file === configDirectory) return originalChmod(file, mode);
      assert.equal(file, observeTemporary());
      throw injected;
    };
  } else {
    fs.renameSync = (from, to) => {
      assert.equal(from, observeTemporary());
      assert.equal(to, destination);
      throw injected;
    };
  }
  syncBuiltinESMExports();
  const failed = writeWorkspaceSshConfig(configFile, parsed.value, null);
  assert.equal(failed.ok, false);
  assert.equal(failed.error.operation, "config");
  assert.equal(failed.error.cause, injected);
} finally {
  fs.fsyncSync = originalFsync;
  fs.chmodSync = originalChmod;
  fs.renameSync = originalRename;
  syncBuiltinESMExports();
}

// Prove complete temporary bytes existed before the injected failure. This is
// deliberately stronger than a refusal before opening the replacement file.
assert.ok(observed);
assert.ok(observed.contents.includes(`Host ${parsed.value.alias}\n`));
assert.ok(observed.contents.includes(before));
assert.notEqual(observed.inode, originalInode);
if (descriptor !== undefined) {
  assert.throws(() => fs.fstatSync(descriptor), { code: "EBADF" });
}
assert.equal(fs.readFileSync(destination, "utf8"), before);
assert.equal(fs.statSync(destination).ino, originalInode);
assert.equal(fs.statSync(destination).mode & 0o777, 0o640);
assert.deepEqual(fs.readdirSync(destinationDirectory), ["config"]);
assert.equal(fs.lstatSync(configFile).isSymbolicLink(), linked);
if (linked) {
  assert.equal(fs.readlinkSync(configFile), path.relative(configDirectory, destination));
  assert.deepEqual(fs.readdirSync(configDirectory), ["config"]);
}

assert.equal(writeWorkspaceSshConfig(configFile, parsed.value, null).ok, true);
const recovered = fs.readFileSync(destination, "utf8");
assert.ok(recovered.includes(`Host ${parsed.value.alias}\n`));
assert.ok(recovered.includes(before));
assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
assert.deepEqual(fs.readdirSync(destinationDirectory), ["config"]);
assert.equal(fs.lstatSync(configFile).isSymbolicLink(), linked);
console.log(
  JSON.stringify({
    stage,
    linked,
    temporaryObserved: true,
    oldFilePreserved: true,
    retrySucceeded: true,
  }),
);
