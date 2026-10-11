import { buildServer } from './http/server.js';

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? '127.0.0.1';

// Provider adapters (0x, 1inch, LI.FI, Jupiter, ...) are registered here as they are built.
const app = buildServer({ providers: [], logger: true });

app.listen({ port, host }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
