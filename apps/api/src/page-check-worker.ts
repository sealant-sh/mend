// A bundle entry of its own (package.json `build`), so `dist/page-check-worker.js` sits beside
// `dist/main.js` as this file sits beside `src/main.ts`.
// oxlint-disable-next-line import/no-unassigned-import -- the worker runs as the module loads.
import "@mend/sessions/page-check-worker";
