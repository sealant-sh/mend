/**
 * The endpoint an API-key login sends its requests to (ADR 0018, decision 11), as the platform
 * parses it. Its own entry point, so only code that reads a pasted endpoint loads Sealant's
 * contract.
 */
export { EndpointUrl, endpointHostOf, parseEndpointUrl } from "@sealant/api-contracts";
