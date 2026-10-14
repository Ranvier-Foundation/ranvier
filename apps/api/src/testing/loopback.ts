import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Real HTTP servers on 127.0.0.1 for tests that need Node's real fetch: redirects, stalled
 * bodies, and what a second host would receive. Close them with `closeAll()` in `afterEach`.
 */

export interface Received {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

export type Behaviour =
  /** Answer every request with this redirect. */
  | { kind: 'redirect'; status: number; location: string }
  /** Send `200`, headers and the start of a body, then never finish. */
  | { kind: 'stall' }
  /** Answer normally (the handler). */
  | { kind: 'normal' };

export interface Loopback {
  url: string;
  received: Received[];
  behaviour: Behaviour;
}

export type Handler = (req: Received) => Promise<{ status: number; body: string }>;

const open: Server[] = [];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/** Starts a loopback server; `handler` answers requests while the behaviour is `normal`. */
export async function loopback(handler: Handler): Promise<Loopback> {
  const lb: Loopback = { url: '', received: [], behaviour: { kind: 'normal' } };
  const server = createServer((req, res) => {
    void readBody(req).then(async (body) => {
      const received: Received = { method: req.method, url: req.url, headers: req.headers, body };
      lb.received.push(received);
      const b = lb.behaviour;
      if (b.kind === 'redirect') {
        res.writeHead(b.status, { location: b.location });
        res.end();
        return;
      }
      if (b.kind === 'stall') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '4096' });
        res.write('{"jsonrpc":"2.0","id":1,"result":"0x');
        return; // never ends; closed with the server
      }
      const answer = await handler(received);
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(answer.body);
    });
  });
  open.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  lb.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return lb;
}

/** Closes every server started by `loopback`, dropping stalled connections. */
export async function closeAll(): Promise<void> {
  await Promise.all(
    open.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => resolve());
        }),
    ),
  );
}
