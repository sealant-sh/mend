# @mend/oxlint-plugin-mend

Mend's own oxlint rules, loaded as a JS plugin by the root `.oxlintrc.json`. They run on the web app
(`apps/web`) and its UI kit (`packages/ui`) only, except `mend/span-name`, which runs on every app's
and package's `src`. New code there passes them without disable comments: when ordinary code trips a
rule, the rule is wrong and gets narrowed here.

The rules are syntactic. oxlint's JS plugins get no type information, so each rule reads one file
and says below what it can't see.

```sh
pnpm --filter @mend/oxlint-plugin-mend test
```

## `mend/query-states`

A component or hook that reads a TanStack Query result's data also says what a person sees while it
loads and when it fails.

**`useQuery` and `useInfiniteQuery`.** Reading `data` needs both:

- a pending branch: `isPending`, `isLoading` or `status`;
- an error branch: `isError`, `error` or `status`.

```tsx
// Flagged: "This query's pending and error states aren't handled."
const { data } = useQuery(sessionsQuery());
return <List items={data} />;

// Allowed
const sessions = useQuery(sessionsQuery());
switch (sessions.status) {
  case "pending":
    return <Loading />;
  case "error":
    return <Failed error={sessions.error} />;
  case "success":
    return <List items={sessions.data} />;
}
```

Also allowed:

- Handing the whole result on, as a prop or an argument (`<QueryView query={sessions} />`,
  `renderQuery(sessions, …)`). Whatever takes it renders its states. This goes by shape, not by
  name.
- Returning the whole result from a hook (`function useSessions() { return useQuery(…) }`). The rule
  then checks what each caller of that hook in the same file reads.
- `throwOnError` in the options, which hands the error to the route's error component; pending is
  still needed.
- `initialData` in the options, which means there is no pending state; the error is still needed.

**`useMutation`.** A mutation reads its pending state (`isPending` or `status`) and handles its
failure (`isError`, `error` or `status`, an `onError` on the hook or on every `mutate` call, or
every `mutateAsync` inside a `try` or followed by `.catch`).

```tsx
// Flagged: "This mutation's failure isn't handled."
const { mutate, isPending } = useMutation(trpc.sessions.archive.mutationOptions());
return (
  <button type="button" disabled={isPending} onClick={() => mutate({ id })}>
    Archive
  </button>
);

// Allowed
const archive = useMutation(trpc.sessions.archive.mutationOptions());
return (
  <>
    <button type="button" disabled={archive.isPending} onClick={() => archive.mutate({ id })}>
      Archive
    </button>
    {archive.error ? <Failed error={archive.error} /> : null}
  </>
);
```

Also allowed:

- `onMutate` in the options stands for the pending state: an optimistic update shows the change at
  once.
- Handing the whole mutation on, as for queries.
- A `mutateAsync` promise handed to a component prop or a function argument, returned or awaited
  outside a `try`: whatever takes it awaits it, so it knows while it runs and gets the failure. A
  DOM element's handler (`<button onClick>`) doesn't count; it ignores the promise.
- A mutation with a `mutationKey` in a file that reads mutations through the cache with
  `useMutationState` or `useIsMutating`.

Mutation errors are handled where the person acted, not by one global `MutationCache` handler: a
global toast can't say which control failed or put the old value back.

**`useQueries`.** `const [a, b] = useQueries(…)` checks each element on its own. A list kept whole
is checked by what is read off any of its elements: `results[0].data`,
`results.some((r) => r.isPending)`, `results.map((r) => r.data)`, `for (const r of results)`.

**`useSuspenseQuery` and `useSuspenseQueries`** are not checked: their pending and error states are
the route's, which `mend/router-default-states` makes sure exist.

**What it can't see**, and so lets through:

- A hook in another file that returns a query. `useSessions().data` is not checked when
  `useSessions` is imported. Export query options instead (`sessionsQuery()`, or tRPC's
  `trpc.x.queryOptions()`) and call `useQuery` in the component, which
  `@tanstack/query/prefer-query-options` also asks for.
- Mutation options built by a call other than tRPC's `mutationOptions(…)`, or imported. Such a
  factory may update optimistically in a way the rule can't read, so the rule doesn't ask for the
  pending state; it still asks for the failure.
- Whether a component handed a whole result renders its states.
- A `throwOnError` set in the `QueryClient`'s default options.
- In a `useQueries` list kept whole, which element a read came from.
- `useQueries` with `combine`, which returns whatever `combine` builds.

## `mend/router-default-states`

The `createRouter` call sets `defaultPendingComponent`, `defaultErrorComponent` and
`defaultNotFoundComponent`, so every route shows the app's own loading, failure and not-found
screens. The rule reads the object passed to `createRouter`, through spreads and `const` bindings in
the same file; options built elsewhere read as unset. Off in tests.

```tsx
// Flagged: "createRouter doesn't set `defaultNotFoundComponent`."
createRouter({ routeTree, defaultPendingComponent: Loading, defaultErrorComponent: Failed });

// Allowed
createRouter({
  routeTree,
  defaultPendingComponent: Loading,
  defaultErrorComponent: Failed,
  defaultNotFoundComponent: NotFound,
});
```

## `mend/no-raw-colors`

Colours come from the kit's tokens. In a `.tsx` file, no hex, `rgb()`, `hsl()`, `oklch()` or
`oklab()` in any string; in a `.ts` file, none inside a Tailwind arbitrary value. A `.ts` file may
still hold a palette a library needs, such as a terminal theme. An in-page `href="#…"` is not a
colour.

```tsx
<div className="bg-[#0a0a0a]" />      // Flagged: "`#0a0a0a` is a raw colour."
<path fill="#fff" />                   // Flagged
<div className="bg-surface" />         // Allowed
<div style={{ color: "var(--x)" }} />  // Allowed
```

## `mend/no-arbitrary-type-or-radius`

Type sizes and radii come from the kit's scale: no `text-[13px]`, `text-[length:0.8rem]` or
`rounded-[7px]` (any corner). A value worked out from a token
(`rounded-[min(var(--radius-md),10px)]`), `var(…)` and keywords (`rounded-[inherit]`) are allowed,
and so are arbitrary widths and heights.

```tsx
<p className="text-[12.5px]" />  // Flagged: "`text-[12.5px]` sets a type size off the kit's scale."
<p className="text-sm" />        // Allowed
<div className="w-[37px]" />     // Allowed
```

## `mend/no-use-client`

No `"use client"` directive: this repo is not Next.js, and TanStack Start does not read it. Some
shadcn registry files carry one; remove it.

## `mend/no-effect-fetch`

No `fetch()` (or `window.fetch()`) inside a `useEffect` or `useLayoutEffect` callback, nested
functions included. A fetch in an effect has no pending or error state for anyone to render and no
cache. Use `useQuery`, or the route's loader. A `fetch` in an event handler is fine.

```tsx
useEffect(() => {
  fetch("/api/sessions").then(...);  // Flagged
}, []);
```

## `mend/no-state-copy-effect`

An effect with dependencies whose body only calls `useState` setters copies values into state, so
for one render the screen shows the old value. Compute the value while rendering (with `useMemo` if
it is costly), or give the component a `key` so its state resets. A mount-only effect (`[]`, such as
noting hydration) and an effect that does anything else are allowed.

```tsx
const [draft, setDraft] = useState(name);
useEffect(() => {
  setDraft(name);
}, [name]); // Flagged
```

## `mend/span-name`

A span the code names has an entry in `SPAN_NAMES` (`packages/telemetry/src/span-names.ts`): the
`mend.<area>.<operation>` name and the short description Sentry shows for it. The exporter renames
each span by that table, so the code can keep naming a span for the function it times.

```ts
// Flagged: "Span "SlackReporter.look" has no entry in SPAN_NAMES …"
const look = Effect.fn("SlackReporter.look")(function* () { … });

// Allowed, once SPAN_NAMES holds
//   "SlackReporter.look": ["mend.slack.update_thread", "update session slack thread"],
const look = Effect.fn("SlackReporter.look")(function* () { … });
```

It reads the literal name of `Effect.fn("…")`, `withSpan("…")` (either argument order), `makeSpan`,
`makeSpanScoped`, `useSpan` and `tracer.span({ name: "…" })`. Also allowed:

- `Effect.fnUntraced`, which makes no span.
- A name built at run time (`` `mend.web.${path}` ``): the exporter names those by rule.
- Test files, whose spans never reach Sentry.

`span-names.test.ts` in `packages/telemetry` checks the table itself: every name follows the
convention, no two names share a description, and no entry outlives its span.
