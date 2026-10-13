import { Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { PushSender, PushSendError, type PushMessage } from "./push-sender.ts";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const ExpoResponse = Schema.Struct({
  data: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        status: Schema.String,
        details: Schema.optionalKey(Schema.Struct({ error: Schema.optionalKey(Schema.String) })),
      }),
    ),
  ),
});

/** Expo wire adapter; keeps ordered receipt pairing private and never retries delivery. */
export const ExpoPushSenderLive: Layer.Layer<PushSender, never, HttpClient.HttpClient> =
  Layer.effect(
    PushSender,
    Effect.gen(function* () {
      const client = HttpClient.withScope(yield* HttpClient.HttpClient);
      const send = Effect.fn("ExpoPushSender.send")(function* (
        messages: ReadonlyArray<PushMessage>,
      ) {
        const request = yield* HttpClientRequest.post(EXPO_PUSH_URL).pipe(
          HttpClientRequest.bodyJson(
            messages.map((message) => ({
              to: Redacted.value(message.token),
              title: message.title,
              body: message.body,
              data: message.data,
              sound: "default",
            })),
          ),
          Effect.mapError(() => new PushSendError({ reason: "request" })),
        );
        const response = yield* client
          .execute(request)
          .pipe(Effect.mapError(() => new PushSendError({ reason: "request" })));
        if (response.status < 200 || response.status >= 300) {
          return yield* new PushSendError({ reason: "rejected", status: response.status });
        }
        const parsed = yield* HttpClientResponse.schemaBodyJson(ExpoResponse)(response).pipe(
          Effect.mapError(() => new PushSendError({ reason: "response", status: response.status })),
        );
        // Receipts align with request order. Missing data or excess receipts cannot invent tokens.
        return (parsed.data ?? []).flatMap((ticket, index) => {
          const message = messages[index];
          return ticket.details?.error === "DeviceNotRegistered" && message !== undefined
            ? [message.token]
            : [];
        });
      }, Effect.scoped);
      return PushSender.of({ send });
    }),
  );
