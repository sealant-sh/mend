import type { MendApi } from "@mend/api-contracts";
import type { Brand } from "effect";
import type { HttpApi, HttpApiGroup } from "effect/unstable/httpapi";

/**
 * The renderer's view of `@mend/api-contracts`, at the type level only: no schema and no Effect
 * runtime reach the bundle for this. An endpoint is named by its method and its path template
 * exactly as the contract declares it (`"GET", "/api/sessions/:id"`), so a route the contract
 * moves or drops fails the build, and its params, query, payload and answer are read off the
 * same declaration.
 *
 * Answers are typed as they arrive over JSON (`Wire`): the server encodes the decoded value, so
 * timestamps and record sequences are strings and ids carry no brand. The renderer trusts the
 * server's shape and does not decode it again; the contract is the promise, and the build is
 * where drift shows.
 */

type Groups = typeof MendApi extends HttpApi.HttpApi<infer _Id, infer G> ? G : never;
type Endpoint = HttpApiGroup.Endpoints<Groups>;

export type Method = Endpoint["method"];

/** Every path template the contract serves under `method`. */
export type PathOf<M extends Method> = Extract<Endpoint, { readonly method: M }>["path"];

type At<M extends Method, P extends string> = Extract<
  Endpoint,
  { readonly method: M; readonly path: P }
>;

type TypeOf<S> = S extends { readonly Type: infer T } ? T : never;

/**
 * A decoded contract type as JSON carries it: dates and bigints travel as strings, brands stay
 * behind, class instances are plain objects.
 */
export type Wire<T> = T extends Date | bigint
  ? string
  : T extends string & Brand.Brand<infer _Keys>
    ? string
    : T extends number & Brand.Brand<infer _Keys>
      ? number
      : T extends string | number | boolean | null | undefined
        ? T
        : T extends ReadonlyArray<infer U>
          ? ReadonlyArray<Wire<U>>
          : T extends object
            ? { readonly [K in keyof T]: Wire<T[K]> }
            : T;

/** What the endpoint at `method path` answers. */
export type Answer<M extends Method, P extends string> = Wire<TypeOf<At<M, P>["~Success"]>>;

/** What the endpoint at `method path` takes as its body. */
export type Payload<M extends Method, P extends string> = Wire<TypeOf<At<M, P>["~Payload"]>>;

type Field<K extends string, T, Optional extends boolean> = [T] extends [never]
  ? Record<never, never>
  : Optional extends true
    ? { readonly [key in K]?: T }
    : { readonly [key in K]: T };

/** Path params, query and body — each only where the endpoint declares one. */
export type Input<M extends Method, P extends string> = Field<
  "params",
  Wire<TypeOf<At<M, P>["~Params"]>>,
  false
> &
  Field<"query", Wire<TypeOf<At<M, P>["~Query"]>>, true> &
  Field<"body", Payload<M, P>, false>;

/** The input argument: required when the endpoint needs params or a body, absent otherwise. */
export type InputArgs<M extends Method, P extends string> =
  Record<never, never> extends Input<M, P> ? [input?: Input<M, P>] : [input: Input<M, P>];

/** The runtime view of an `Input`, for filling the template. */
export interface RawInput {
  readonly params: object | undefined;
  readonly query: object | undefined;
  readonly body: unknown;
}

const objectField = (value: object, key: string): object | undefined => {
  const field: unknown = Reflect.get(value, key);
  return typeof field === "object" && field !== null ? field : undefined;
};

/** Reads a typed `Input` back as plain fields; anything else reads as no input. */
export const rawInput = (value: unknown): RawInput => {
  if (typeof value !== "object" || value === null) {
    return { params: undefined, query: undefined, body: undefined };
  }
  return {
    params: objectField(value, "params"),
    query: objectField(value, "query"),
    body: "body" in value ? Reflect.get(value, "body") : undefined,
  };
};

/** `/api/sessions/:id` + `{ id }` → `/api/sessions/<id>`, with the query appended. */
export const fillPath = (template: string, input: RawInput): string => {
  const path = template.replace(/:(\w+)/g, (_match, key: string) => {
    const value: unknown = input.params === undefined ? undefined : Reflect.get(input.params, key);
    if (value === undefined || value === null) throw new Error(`${template}: no value for :${key}`);
    return encodeURIComponent(String(value));
  });
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined && value !== null) query.set(key, String(value));
  }
  const search = query.toString();
  return search === "" ? path : `${path}?${search}`;
};
