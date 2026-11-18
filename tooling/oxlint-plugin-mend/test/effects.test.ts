import { noEffectFetch, noStateCopyEffect } from "../src/rules/effects.ts";
import { tester } from "./tester.ts";

const REACT = `import { useEffect, useLayoutEffect, useState } from "react";\n`;

tester.run("no-effect-fetch", noEffectFetch, {
  valid: [
    {
      name: "fetch in an event handler",
      code: `${REACT}function Upload() {
        return <button type="button" onClick={() => fetch("/upload", { method: "POST" })}>Upload</button>;
      }`,
    },
    {
      name: "an effect that subscribes",
      code: `${REACT}function Size() {
        useEffect(() => {
          const onResize = () => measure();
          window.addEventListener("resize", onResize);
          return () => window.removeEventListener("resize", onResize);
        }, []);
        return null;
      }`,
    },
    {
      name: "a local function named fetch",
      code: `${REACT}function Pull({ fetch }) {
        useEffect(() => { fetch(); }, [fetch]);
        return null;
      }`,
    },
  ],
  invalid: [
    {
      name: "fetch inside an effect",
      code: `${REACT}function Sessions() {
        const [sessions, setSessions] = useState([]);
        useEffect(() => {
          fetch("/api/sessions").then((response) => response.json()).then(setSessions);
        }, []);
        return <List items={sessions} />;
      }`,
      errors: [{ messageId: "fetch" }],
    },
    {
      name: "window.fetch inside an async function inside React.useLayoutEffect",
      code: `import React from "react";
      function Sessions() {
        React.useLayoutEffect(() => {
          async function load() { await window.fetch("/api/sessions"); }
          void load();
        }, []);
        return null;
      }`,
      errors: [{ messageId: "fetch" }],
    },
  ],
});

tester.run("no-state-copy-effect", noStateCopyEffect, {
  valid: [
    {
      name: "a mount-only effect, such as noting hydration",
      code: `${REACT}function Clock() {
        const [mounted, setMounted] = useState(false);
        useEffect(() => { setMounted(true); }, []);
        return mounted ? <Time /> : null;
      }`,
    },
    {
      name: "an effect that does more than set state",
      code: `${REACT}function Title({ title }) {
        const [shown, setShown] = useState(title);
        useEffect(() => {
          document.title = title;
          setShown(title);
        }, [title]);
        return <h1>{shown}</h1>;
      }`,
    },
    {
      name: "a setter that isn't useState's",
      code: `${REACT}function Title({ title, setTitle }) {
        useEffect(() => { setTitle(title); }, [title, setTitle]);
        return null;
      }`,
    },
  ],
  invalid: [
    {
      name: "a prop copied into state",
      code: `${REACT}function Name({ name }) {
        const [draft, setDraft] = useState(name);
        useEffect(() => { setDraft(name); }, [name]);
        return <input value={draft} onChange={(event) => setDraft(event.target.value)} />;
      }`,
      errors: [{ messageId: "copy" }],
    },
    {
      name: "state reset when a value changes, with an expression body",
      code: `${REACT}function Menu({ pathname }) {
        const [open, setOpen] = useState(false);
        useLayoutEffect(() => setOpen(false), [pathname]);
        return open ? <Panel /> : null;
      }`,
      errors: [{ messageId: "copy" }],
    },
  ],
});
