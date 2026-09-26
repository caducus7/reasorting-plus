import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8080);
const hostname = process.env.HOST ?? "0.0.0.0";

serve({ fetch: createApp().fetch, port, hostname }, (info) => {
  console.log(`api-stub listening on http://${hostname}:${info.port}/v1 (OpenAPI at /v1/openapi.json)`);
});
