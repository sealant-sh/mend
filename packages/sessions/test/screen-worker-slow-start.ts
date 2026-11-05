/** The screen worker, on a thread that takes longer to start than a request may take. */
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_500);
await import("../src/screen/screen-worker.ts");
