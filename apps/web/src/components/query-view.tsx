import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { QueryError, QueryPending } from "./route-screens.tsx";

/**
 * The loaded child, refused when it takes its data as optional: once a query has loaded, its data
 * is there, so a child written for `undefined` means the screen was built for a state it never
 * gets. A query whose data can itself be `undefined` keeps it.
 */
type Loaded<TData, Child> = Child extends (data: infer Taken) => ReactNode
  ? undefined extends Taken
    ? undefined extends TData
      ? Child
      : never
    : Child
  : never;

export interface QueryViewProps<TData, TError, Child extends (data: TData) => ReactNode> {
  /** The query's whole result, as `useQuery` returns it. */
  readonly query: UseQueryResult<TData, TError>;
  /** What the page shows once the query has loaded. */
  readonly children: Child & Loaded<TData, Child>;
  /** In place of the default line while the first read runs. */
  readonly pending?: ReactNode;
  /** In place of the default alert when the read failed; `retry` reads it again. */
  readonly error?: (error: TError, retry: () => void) => ReactNode;
  /** What the page shows when the query loaded and holds nothing (`isEmpty`). */
  readonly empty?: ReactNode;
  /** When the loaded data counts as empty. Without one, an empty list or `null` does. */
  readonly isEmpty?: (data: TData) => boolean;
}

const nothing = (data: unknown): boolean =>
  data === null || (Array.isArray(data) && data.length === 0);

/**
 * One way to render a query: its first read, its failure (with Try again), nothing to show, and
 * what it loaded. Pending and failure have Sheet's defaults; a caller replaces any of the four.
 * The empty state shows only when the caller gives one, since only the page knows what to say.
 */
export function QueryView<TData, TError, Child extends (data: TData) => ReactNode>({
  query,
  children,
  pending,
  error,
  empty,
  isEmpty = nothing,
}: QueryViewProps<TData, TError, Child>): ReactNode {
  switch (query.status) {
    case "pending":
      return pending ?? <QueryPending />;
    case "error": {
      const retry = () => void query.refetch();
      return error === undefined ? (
        <QueryError error={query.error} retry={retry} retrying={query.isFetching} />
      ) : (
        error(query.error, retry)
      );
    }
    case "success":
      return empty !== undefined && isEmpty(query.data) ? empty : children(query.data);
  }
}
