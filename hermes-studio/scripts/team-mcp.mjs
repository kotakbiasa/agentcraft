// AgentCraft team tools as a stdio MCP server for Hermes agents ("agentcraft").
//
// Hermes spawns this script (configured in the per-agent HERMES_HOME config.yaml, see
// src/agents/hermes/home.ts) and speaks newline-delimited JSON-RPC 2.0 over stdin/stdout.
// Tool schemas come from a JSON file the engine writes per turn (AGENTCRAFT_TOOLS_JSON);
// tool calls are forwarded to the engine over a Unix socket (AGENTCRAFT_SOCKET), which
// runs them against the live turn's handlers (send_message, ask_user, update_task, ...).
//
// Deliberately dependency-free (Node stdlib only): it is spawned by an external process
// (hermes) that cannot resolve the foreman's node_modules.
import fs from 'node:fs';
import net from 'node:net';
import readline from 'node:readline';

const TOOLS_JSON = process.env.AGENTCRAFT_TOOLS_JSON;
const SOCKET = process.env.AGENTCRAFT_SOCKET;
const SERVER_NAME = 'agentcraft';

/** Tools as the engine exported them: [{name, description, inputSchema}] (JSON Schema). */
function loadTools() {
  if (!TOOLS_JSON) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(TOOLS_JSON, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

/** One tool call -> the engine -> the turn's AgentTool handler. Resolves with MCP content. */
function callEngine(name, args) {
  return new Promise((resolve, reject) => {
    if (!SOCKET) return reject(new Error('AGENTCRAFT_SOCKET is not set'));
    const sock = net.connect(SOCKET);
    let buf = '';
    const done = (fn, v) => {
      try { sock.destroy(); } catch {}
      fn(v);
    };
    sock.on('connect', () => sock.write(JSON.stringify({ name, arguments: args ?? {} }) + '\n'));
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let msg;
      try {
        msg = JSON.parse(buf.slice(0, nl));
      } catch (e) {
        return done(reject, new Error(`bad engine reply: ${String(e)}`));
      }
      if (msg.error) return done(reject, new Error(String(msg.error)));
      const res = msg.result ?? {};
      done(resolve, {
        content: [{ type: 'text', text: String(res.text ?? '') }],
        ...(res.isError ? { isError: true } : {}),
      });
    });
    sock.on('error', (e) => done(reject, new Error(`engine socket: ${e.message}`)));
    setTimeout(() => done(reject, new Error('engine socket timed out')), 10 * 60_000).unref?.();
  });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

rl.on('line', async (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return; // not JSON-RPC: ignore
  }
  const { id, method, params } = req;
  if (id === undefined || id === null) return; // notification: nothing to answer
  try {
    switch (method) {
      case 'initialize':
        return send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: params?.protocolVersion ?? '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: '0.1.0' },
          },
        });
      case 'ping':
        return send({ jsonrpc: '2.0', id, result: {} });
      case 'tools/list': {
        const tools = loadTools().map((t) => ({
          name: t.name,
          description: t.description ?? '',
          inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
        }));
        return send({ jsonrpc: '2.0', id, result: { tools } });
      }
      case 'tools/call': {
        const name = String(params?.name ?? '');
        const args = params?.arguments ?? {};
        if (!loadTools().some((t) => t.name === name)) {
          return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true } });
        }
        const res = await callEngine(name, args);
        return send({ jsonrpc: '2.0', id, result: res });
      }
      default:
        return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
  }
});
