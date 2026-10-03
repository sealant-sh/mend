#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Layer from "effect/Layer";

import { GatewayConfigFromEnv } from "./config.ts";
import { GatewayServerLive } from "./server.ts";

// Off unless run: nothing in Mend starts the gateway (ADR 0012, "Access").
NodeRuntime.runMain(Layer.launch(GatewayServerLive.pipe(Layer.provide(GatewayConfigFromEnv))));
