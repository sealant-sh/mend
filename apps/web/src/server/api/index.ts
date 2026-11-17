/**
 * The web tier's one doorway to the Mend API: a client DERIVED from
 * @mend/api-contracts (paths, params, encoding, decoding and typed errors all
 * come from the contract), built per request so the caller's credentials ride
 * along, run on a shared Effect runtime, with contract failures translated to
 * TRPCError at exactly one place. tRPC procedures use `run(ctx, (api) => ...)`
 * and nothing else.
 */
export { apiClientFor, run, type TrpcContext } from "./run.ts";
