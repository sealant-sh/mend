---
"@sealant/mend": minor
---

The Mend server can accept a session in a project that is still cloning. The session waits, and
starts by itself when the clone finishes, with the prompt, agent, model, effort and worktree the
person chose, as if they had started it then. If the clone fails, the session says so with the
clone's reason and can be started again, with nothing retyped, once the project is cloned. Its owner
can cancel it while it waits. A session that is waiting or failed when the server restarts is not
lost: its clone stopped with the server, so it says so, unless the clone had already finished, in
which case it starts once. The API is `POST /api/queued-sessions` with the adoption's id, then
`GET`, `POST …/start` and `DELETE` on `/api/queued-sessions/:id`. No client offers it yet; the new
web app's New session screen will. Starting a session in a project that is already cloned works as
before, from every client.
