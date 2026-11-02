import type { DataTag, MutationFunctionContext, QueryKey } from "@tanstack/react-query";

/**
 * The callbacks that make a mutation optimistic over one cached read: the read changes the moment
 * the person acts, goes back to what it was if the server refuses, and is read again either way.
 * Spread them into `mutationOptions`, and show `mutation.error` beside the control.
 *
 * ```ts
 * const save = useMutation(trpc.platform.setMessageSettings.mutationOptions(
 *   optimisticOver(trpc.platform.messageSettings.queryKey(), (_current, next) => next),
 * ));
 * ```
 */
export const optimisticOver = <TData, TError, TVariables>(
  queryKey: DataTag<QueryKey, TData, TError>,
  apply: (current: TData, variables: TVariables) => TData,
) => ({
  onMutate: async (variables: TVariables, { client }: MutationFunctionContext) => {
    await client.cancelQueries({ queryKey });
    const previous = client.getQueryData(queryKey);
    if (previous !== undefined) client.setQueryData(queryKey, apply(previous, variables));
    return { previous };
  },
  onError: (
    _error: unknown,
    _variables: TVariables,
    result: { readonly previous: TData | undefined } | undefined,
    { client }: MutationFunctionContext,
  ) => {
    if (result?.previous !== undefined) client.setQueryData(queryKey, result.previous);
  },
  onSettled: (
    _data: unknown,
    _error: unknown,
    _variables: TVariables,
    _result: unknown,
    { client }: MutationFunctionContext,
  ) => client.invalidateQueries({ queryKey }),
});
