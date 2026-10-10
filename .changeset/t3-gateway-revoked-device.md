---
"@sealant/mend": patch
---

Revoking a `t3code · …` device in Mend now signs that t3code client out of the gateway. Before, the
gateway noticed the revocation and closed the client's sockets, but its bearer kept getting
WebSocket tickets, so t3code showed the environment as reconnecting forever. The bearer is now
revoked before anything closes, each ticket checks with Mend that the device is still paired, and a
gateway start checks every paired device once, so a device revoked while the gateway was down ends
at its next start. t3code shows "Connection failed: The environment credential is invalid." and
stops reconnecting. Deleting a thread's worktree from t3code now says that Mend keeps it and where
to remove it, instead of that the gateway does not offer the method. Every route that serves a
person's data now asks Mend whether the device is still paired (once per device per five seconds),
and while Mend cannot be reached the gateway answers new connections and snapshot reads with a
retryable `503` instead of serving them from memory.
