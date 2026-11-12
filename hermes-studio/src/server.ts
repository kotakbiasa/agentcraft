// The protocol v1 WebSocket server the Minecraft mod connects to (ws://127.0.0.1:7878).
//
// Same wire contract the mod was built against (docs/protocol.md): the client says `hello` and
// gets a `snapshot`; every message that carried an `id` is answered with an `ack` carrying the
// same id; everything after that is a stream of upserts. This is the transport half of the old
// Foreman server — the orchestration half lives in the studio.
import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Outbound } from './protocol.js';
import type { HermesStudio } from './studio.js';

export class ProtocolServer {
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();

  constructor(private studio: HermesStudio, port: number) {
    const httpServer = http.createServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('agentcraft hermes-studio: websocket only\n');
    });
    this.wss = new WebSocketServer({
      server: httpServer,
      // The mod and the CLI are not browsers; a page that reaches this port is refused.
      verifyClient: (info: { origin?: string; secure: boolean; req: http.IncomingMessage }) =>
        !info.req.headers.origin,
    });
    httpServer.listen(port, '127.0.0.1');
    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      ws.on('message', (raw) => void this.onMessage(ws, raw.toString()));
      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => this.clients.delete(ws));
    });
    studio.log.info(`protocol v1 listening on ws://127.0.0.1:${port}`);
  }

  broadcast(msg: Outbound): void {
    const text = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      ws.send(text, (err) => {
        if (err) this.clients.delete(ws);
      });
    }
  }

  close(): void {
    for (const ws of this.clients) ws.close(1001, 'studio stopping');
    this.clients.clear();
    this.wss.close();
  }

  private async onMessage(ws: WebSocket, raw: string): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.send(ws, { v: 1, id: 'msg-error', type: 'error', message: 'not json' });
      return;
    }
    const id = typeof msg?.id === 'string' ? msg.id : undefined;
    if (msg?.type === 'hello') this.send(ws, this.studio.snapshot());
    const res = await this.studio.handleClient(msg);
    if (id) {
      this.send(ws, {
        v: 1,
        id: `ack-${id}`,
        type: 'ack',
        re: id,
        ok: res.ok,
        error: res.error,
        result: res.result,
      });
    }
  }

  private send(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }
}
