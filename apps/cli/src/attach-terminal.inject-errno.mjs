// Preloaded into the CLI under test (`NODE_OPTIONS=--import`): the native handle's
// `setRawMode(false)` answers the errno `MEND_TEST_RAW_ERRNO` names, as a terminal that is gone
// does on another platform (ENOTTY or EBADF on macOS after revoke(), ENXIO on FreeBSD), or as a
// live one that refuses for another reason. Node's own `tty.ReadStream.setRawMode`, the CLI's
// `leaveRawMode` and its foreground stop all run unchanged. Entering raw mode is left alone.
import { constants } from "node:os";

if (process.argv[1]?.endsWith("/apps/cli/src/main.ts")) {
  // oxlint-disable-next-line no-underscore-dangle -- the native handle has no other name
  const handle = process.stdin._handle;
  const original = handle.setRawMode;
  handle.setRawMode = function (mode) {
    if (!mode) return -constants.errno[process.env.MEND_TEST_RAW_ERRNO];
    return original.call(this, mode);
  };
}
