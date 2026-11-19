import { MintDeviceRequest } from "@mend/api-contracts";
import { NotificationSettings } from "@mend/domain/workbench";
import { Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

/** Paired devices — pairing itself (`/api/pair`) stays unauthenticated on the raw API. */
export const devicesRouter = router({
  list: procedure.query(({ ctx }) => run(ctx, (api) => api.userDevices.list())),
  createPairing: procedure.mutation(({ ctx }) =>
    run(ctx, (api) => api.userDevices.createPairing()),
  ),
  // A token minted by hand, for a device that cannot scan a code. Shown once.
  create: procedure
    .input(input(MintDeviceRequest))
    .mutation(({ ctx, input: i }) => run(ctx, (api) => api.userDevices.create({ payload: i }))),
  revoke: procedure
    .input(input(Schema.Struct({ id: Schema.String })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.userDevices.revoke({ params: { id: i.id } })),
    ),
  // What the signed-in person's phones hear about (`GET`/`PUT /me/notifications`). A save sends
  // the whole setting and answers it as saved.
  notificationSettings: procedure.query(({ ctx }) =>
    run(ctx, (api) => api.devices.notificationSettings()),
  ),
  setNotificationSettings: procedure
    .input(input(NotificationSettings))
    .mutation(({ ctx, input: payload }) =>
      run(ctx, (api) => api.devices.setNotificationSettings({ payload })),
    ),
  // The CLI authorize walk (`mend login`): the /authorize page reads the
  // pending request by its short code, then the signed-in user decides.
  cliAuthRequest: procedure
    .input(input(Schema.Struct({ code: Schema.String })))
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.userDevices.cliAuthRequest({ params: { code: i.code } })),
    ),
  approveCliAuth: procedure
    .input(input(Schema.Struct({ code: Schema.String })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.userDevices.approveCliAuth({ params: { code: i.code } })),
    ),
  denyCliAuth: procedure
    .input(input(Schema.Struct({ code: Schema.String })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.userDevices.denyCliAuth({ params: { code: i.code } })),
    ),
});
