import { queryStates } from "../src/rules/query-states.ts";
import { tester } from "./tester.ts";

const RQ = `import { useInfiniteQuery, useMutation, useQueries, useQuery, useSuspenseQuery } from "@tanstack/react-query";\n`;

tester.run("query-states", queryStates, {
  valid: [
    {
      name: "destructures data with its pending and error flags",
      code: `${RQ}function Sessions() {
        const { data, isPending, isError } = useQuery(sessionsQuery());
        if (isPending) return <Loading />;
        if (isError) return <Failed />;
        return <List items={data} />;
      }`,
    },
    {
      name: "switches on status, which covers both",
      code: `${RQ}function Sessions() {
        const sessions = useQuery(sessionsQuery());
        switch (sessions.status) {
          case "pending": return <Loading />;
          case "error": return <Failed error={sessions.error} />;
          case "success": return <List items={sessions.data} />;
        }
      }`,
    },
    {
      name: "returns early, then reads data",
      code: `${RQ}function Sessions() {
        const q = useQuery(sessionsQuery());
        if (q.isPending) return <Loading />;
        if (q.error) return <Failed error={q.error} />;
        return <List items={q.data} />;
      }`,
    },
    {
      name: "hands the whole result to a component as a prop",
      code: `${RQ}function Sessions() {
        const sessions = useQuery(sessionsQuery());
        return <QueryView query={sessions}>{(data) => <List items={data} />}</QueryView>;
      }`,
    },
    {
      name: "hands the whole result to a function, then reads data",
      code: `${RQ}function Sessions() {
        const sessions = useQuery(sessionsQuery());
        const count = sessions.data?.length;
        return renderQuery(sessions, () => <List items={sessions.data} count={count} />);
      }`,
    },
    {
      name: "a custom hook returns the query, and its caller handles the states",
      code: `${RQ}function useSessions() {
        return useQuery(sessionsQuery());
      }
      function Sessions() {
        const { data, status } = useSessions();
        if (status !== "success") return <Status status={status} />;
        return <List items={data} />;
      }`,
    },
    {
      name: "a custom arrow hook returns the query, and its caller hands it over",
      code: `${RQ}const useSessions = () => useQuery(sessionsQuery());
      function Sessions() {
        return <QueryView query={useSessions()} />;
      }`,
    },
    {
      name: "throwOnError hands the error to the route, so only pending is needed",
      code: `${RQ}function Sessions() {
        const { data, isPending } = useQuery({ ...trpc.sessions.list.queryOptions(), throwOnError: true });
        return isPending ? <Loading /> : <List items={data} />;
      }`,
    },
    {
      name: "throwOnError passed to tRPC's queryOptions",
      code: `${RQ}function Sessions() {
        const { data, isLoading } = useQuery(trpc.sessions.list.queryOptions(undefined, { throwOnError: true }));
        return isLoading ? <Loading /> : <List items={data} />;
      }`,
    },
    {
      name: "initialData means there is no pending state",
      code: `${RQ}function Sessions({ initial }) {
        const { data, isError } = useQuery({ ...sessionsQuery(), initialData: initial });
        return isError ? <Failed /> : <List items={data} />;
      }`,
    },
    {
      name: "a result whose data is never read",
      code: `${RQ}function Refresh() {
        const { refetch } = useQuery(sessionsQuery());
        return <button type="button" onClick={() => refetch()}>Refresh</button>;
      }`,
    },
    {
      name: "suspense queries leave their states to the route",
      code: `${RQ}function Sessions() {
        const { data } = useSuspenseQuery(sessionsQuery());
        return <List items={data} />;
      }`,
    },
    {
      name: "a useQuery that isn't TanStack's",
      code: `import { useQuery } from "./local-store";
      function Sessions() {
        const { data } = useQuery("sessions");
        return <List items={data} />;
      }`,
    },
    {
      name: "useQueries checked across the list",
      code: `${RQ}function Projects({ ids }) {
        const results = useQueries({ queries: ids.map((id) => projectQuery(id)) });
        if (results.some((result) => result.isPending)) return <Loading />;
        if (results.some((result) => result.isError)) return <Failed />;
        return <List items={results.map((result) => result.data)} />;
      }`,
    },
    {
      name: "useQueries destructured, each element handled",
      code: `${RQ}function Pair() {
        const [left, { data: right, status }] = useQueries({ queries: [aQuery(), bQuery()] });
        if (left.status !== "success" || status !== "success") return <Status />;
        return <Diff left={left.data} right={right} />;
      }`,
    },
    {
      name: "useQueries with combine returns what combine builds",
      code: `${RQ}function Projects({ ids }) {
        const { data } = useQueries({ queries: ids.map(projectQuery), combine: combineAll });
        return <List items={data} />;
      }`,
    },
    {
      name: "a mutation that reads its pending and error states",
      code: `${RQ}function Archive() {
        const archive = useMutation(trpc.sessions.archive.mutationOptions());
        return (
          <>
            <button type="button" disabled={archive.isPending} onClick={() => archive.mutate({ id })}>Archive</button>
            {archive.error ? <Failed error={archive.error} /> : null}
          </>
        );
      }`,
    },
    {
      name: "a mutation destructured, with onError on the hook",
      code: `${RQ}function Archive() {
        const { mutate, isPending } = useMutation({ mutationFn: archive, onError: showFailure });
        return <button type="button" disabled={isPending} onClick={() => mutate()}>Archive</button>;
      }`,
    },
    {
      name: "an optimistic mutation: onMutate stands for pending",
      code: `${RQ}function MarkRead() {
        const markRead = useMutation(trpc.sessions.markRead.mutationOptions({ onMutate: hideBadge, onError: restoreBadge }));
        useOnView(() => markRead.mutate({ id }));
        return null;
      }`,
    },
    {
      name: "onError on each mutate call",
      code: `${RQ}function Archive() {
        const archive = useMutation(archiveOptions);
        return <button type="button" disabled={archive.isPending} onClick={() => archive.mutate(id, { onError: showFailure })}>Archive</button>;
      }`,
    },
    {
      name: "mutateAsync awaited inside a try",
      code: `${RQ}function Rename() {
        const { mutateAsync, isPending } = useMutation(renameOptions);
        async function submit(name) {
          try {
            await mutateAsync({ name });
          } catch (failure) {
            report(failure);
          }
        }
        return <Form busy={isPending} onSubmit={submit} />;
      }`,
    },
    {
      name: "mutateAsync with .catch",
      code: `${RQ}function Rename() {
        const rename = useMutation(renameOptions);
        return <Form busy={rename.status === "pending"} onSubmit={(name) => rename.mutateAsync(name).catch(report)} />;
      }`,
    },
    {
      name: "options from a factory, such as an optimistic writer, need only the failure",
      code: `${RQ}function Toggle() {
        const save = useMutation(settingsWriter.options({ queryClient, documentKey }));
        return (
          <>
            <Switch onCheckedChange={(on) => save.mutate({ on })} />
            {save.isError ? <Failed error={save.error} /> : null}
          </>
        );
      }`,
    },
    {
      name: "a mutateAsync promise handed to a component, which awaits it",
      code: `${RQ}function Removed({ project }) {
        const restore = useMutation(trpc.projects.restore.mutationOptions({ onSettled: refresh }));
        return <RemovedRow project={project} restore={async (name) => { await restore.mutateAsync({ id: project.id, name }); }} />;
      }`,
    },
    {
      name: "a mutation read through the cache by its key",
      code: `import { useIsMutating, useMutation, useMutationState } from "@tanstack/react-query";
      function useLand(changeId) {
        const mutationKey = ["land", changeId];
        const mutation = useMutation({ mutationKey, mutationFn: send });
        const pending = useIsMutating({ mutationKey }) > 0;
        const latest = useMutationState({ filters: { mutationKey }, select: (entry) => entry.state.error }).at(-1);
        return { pending, latest, land: () => mutation.mutate() };
      }`,
    },
    {
      name: "a mutation handed over whole",
      code: `${RQ}function Archive() {
        const archive = useMutation(archiveOptions);
        return <ActionButton mutation={archive}>Archive</ActionButton>;
      }`,
    },
  ],
  invalid: [
    {
      name: "only data, destructured",
      code: `${RQ}function Sessions() {
        const { data } = useQuery(sessionsQuery());
        return <List items={data} />;
      }`,
      errors: [{ messageId: "queryBoth" }],
    },
    {
      name: "renamed destructuring still reads data",
      code: `${RQ}function Sessions() {
        const { data: sessions, isPending: loading } = useQuery(sessionsQuery());
        return loading ? <Loading /> : <List items={sessions} />;
      }`,
      errors: [{ messageId: "queryError" }],
    },
    {
      name: "kept in a variable, data read later, error never read",
      code: `${RQ}function Sessions() {
        const sessions = useQuery(sessionsQuery());
        if (sessions.isPending) return <Loading />;
        return <List items={sessions.data} />;
      }`,
      errors: [{ messageId: "queryError" }],
    },
    {
      name: "error handled, pending never read",
      code: `${RQ}function Sessions() {
        const sessions = useQuery(sessionsQuery());
        if (sessions.isError) return <Failed />;
        return <List items={sessions.data ?? []} />;
      }`,
      errors: [{ messageId: "queryPending" }],
    },
    {
      name: "data read straight off the call",
      code: `${RQ}function Count() {
        return <span>{useQuery(countQuery()).data}</span>;
      }`,
      errors: [{ messageId: "queryBoth" }],
    },
    {
      name: "an infinite query",
      code: `${RQ}function Feed() {
        const { data, fetchNextPage } = useInfiniteQuery(feedQuery());
        return <List pages={data?.pages} more={fetchNextPage} />;
      }`,
      errors: [{ messageId: "queryBoth" }],
    },
    {
      name: "an import renamed, and one through a namespace",
      code: `import { useQuery as useServerData } from "@tanstack/react-query";
      import * as RQ from "@tanstack/react-query";
      function Sessions() {
        const { data } = useServerData(sessionsQuery());
        const other = RQ.useQuery(otherQuery());
        return <List items={data} other={other.data} />;
      }`,
      errors: [{ messageId: "queryBoth" }, { messageId: "queryBoth" }],
    },
    {
      name: "rest destructuring follows the rest object",
      code: `${RQ}function Sessions() {
        const { data, ...rest } = useQuery(sessionsQuery());
        return rest.isPending ? <Loading /> : <List items={data} />;
      }`,
      errors: [{ messageId: "queryError" }],
    },
    {
      name: "a custom hook returns the query, and its caller reads only data",
      code: `${RQ}function useSessions() {
        return useQuery(sessionsQuery());
      }
      function Sessions() {
        const { data } = useSessions();
        return <List items={data} />;
      }`,
      errors: [{ messageId: "queryBoth", line: 6 }],
    },
    {
      name: "a custom hook that reads data itself",
      code: `${RQ}function useSessionNames() {
        const { data } = useQuery(sessionsQuery());
        return data?.map((session) => session.name);
      }`,
      errors: [{ messageId: "queryBoth" }],
    },
    {
      name: "useQueries read across the list without states",
      code: `${RQ}function Projects({ ids }) {
        const results = useQueries({ queries: ids.map((id) => projectQuery(id)) });
        return <List items={results.map((result) => result.data)} />;
      }`,
      errors: [{ messageId: "queryBoth" }],
    },
    {
      name: "useQueries destructured, one element unhandled",
      code: `${RQ}function Pair() {
        const [left, right] = useQueries({ queries: [aQuery(), bQuery()] });
        if (left.status !== "success") return <Status />;
        return <Diff left={left.data} right={right.data} />;
      }`,
      errors: [{ messageId: "queryBoth", line: 3 }],
    },
    {
      name: "a mutation that reads neither state",
      code: `${RQ}function Archive() {
        const archive = useMutation(trpc.sessions.archive.mutationOptions());
        return <button type="button" onClick={() => archive.mutate()}>Archive</button>;
      }`,
      errors: [{ messageId: "mutationBoth" }],
    },
    {
      name: "a mutation that shows progress but never its failure",
      code: `${RQ}function Archive() {
        const { mutate, isPending } = useMutation({ mutationFn: archiveSession });
        return <button type="button" disabled={isPending} onClick={() => mutate()}>Archive</button>;
      }`,
      errors: [{ messageId: "mutationError" }],
    },
    {
      name: "a mutation with onError that never shows progress",
      code: `${RQ}function Archive() {
        const archive = useMutation({ mutationFn: archiveSession, onError: showFailure });
        return <button type="button" onClick={() => archive.mutate()}>Archive</button>;
      }`,
      errors: [{ messageId: "mutationPending" }],
    },
    {
      name: "mutate handed to a prop uncalled",
      code: `${RQ}function Archive() {
        const archive = useMutation(trpc.sessions.archive.mutationOptions());
        return <ArchiveButton busy={archive.isPending} onArchive={archive.mutate} />;
      }`,
      errors: [{ messageId: "mutationError" }],
    },
    {
      name: "options from a factory still need the failure handled",
      code: `${RQ}function Toggle() {
        const save = useMutation({ ...listChangeOptions({ queryClient }) });
        return <Switch onCheckedChange={(on) => save.mutate({ on })} />;
      }`,
      errors: [{ messageId: "mutationError" }],
    },
    {
      name: "mutateAsync outside a try",
      code: `${RQ}function Rename() {
        const { mutateAsync, isPending } = useMutation(renameOptions);
        async function submit() {
          await mutateAsync({ name });
          close();
        }
        return <form aria-busy={isPending} onSubmit={submit} />;
      }`,
      errors: [{ messageId: "mutationError" }],
    },
    {
      name: "one mutate call handles failure and another doesn't",
      code: `${RQ}function Archive() {
        const archive = useMutation(trpc.sessions.archive.mutationOptions());
        return (
          <>
            <button type="button" disabled={archive.isPending} onClick={() => archive.mutate(id, { onError: showFailure })}>Archive</button>
            <button type="button" disabled={archive.isPending} onClick={() => archive.mutate(other)}>Archive other</button>
          </>
        );
      }`,
      errors: [{ messageId: "mutationError" }],
    },
  ],
});
