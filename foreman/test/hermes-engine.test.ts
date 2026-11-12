// The Hermes engine's model-free pieces: the per-agent HERMES_HOME (config merge + credential
// links), the stream-json mapper, and the MCP bridge <-> engine socket contract. The orchestration
// loop itself is exercised against the real hermes CLI (no fake model here).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentHomeDir, ensureAgentHome } from '../src/agents/hermes/home.js';
import { HermesStreamMapper } from '../src/agents/hermes/stream.js';
import type { Foreman } from '../src/foreman.js';
import { rmrf, tempDir } from './helpers.js';

const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'hermes-team-mcp.mjs');

const stubForeman = (logs: Array<{ id: string; kind: string; text: string }>, patches: Array<Record<string, unknown>>): Foreman =>
  ({
    agent: () => undefined,
    setAgent: (_id: string, patch: Record<string, unknown>) => patches.push(patch),
    agentLog: (id: string, kind: string, text: string) => logs.push({ id, kind, text }),
    repos: { scheduleRefresh: () => {} },
  }) as unknown as Foreman;

describe('hermes agent home', () => {
  let root: string;
  let userHome: string;
  let dataDir: string;
  const OLD_HOME = process.env.HERMES_HOME;

  beforeEach(() => {
    root = tempDir('ac-hermes-');
    userHome = path.join(root, 'user-hermes');
    dataDir = path.join(root, 'profile');
    fs.mkdirSync(userHome, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(userHome, 'config.yaml'),
      ['model: my-model', 'mcp_servers:', '  time:', '    command: uvx', 'agent:', '  max_turns: 500', ''].join('\n'),
    );
    fs.writeFileSync(path.join(userHome, '.env'), 'ANTHROPIC_API_KEY=sk-x\nTELEGRAM_BOT_TOKEN=secret\nSOME_KEY=1\n');
    fs.writeFileSync(path.join(userHome, 'auth.json'), '{"tokens":{"provider":"x"}}\n');
    process.env.HERMES_HOME = userHome;
  });

  afterEach(() => {
    if (OLD_HOME === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = OLD_HOME;
    rmrf(root);
  });

  it('adds the team MCP server and the role prompt without losing the user config', () => {
    const dir = ensureAgentHome({ dataDir, agentId: 'kit', bridge: BRIDGE, systemPrompt: 'ROLE PROMPT' });
    const cfg = fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8');
    expect(cfg).toContain('model: my-model'); // the user's own config survives
    expect(cfg).toContain('  time:'); // and their other MCP servers
    expect(cfg).toContain('  agentcraft:');
    expect(cfg).toContain('hermes-team-mcp.mjs');
    expect(cfg).toContain('AGENTCRAFT_SOCKET');
    expect(cfg).toContain('system_prompt: "ROLE PROMPT"');
    expect(cfg).toContain('max_turns: 500');
    // provider credentials: auth.json is linked; .env is a filtered copy (no platform tokens)
    expect(fs.lstatSync(path.join(dir, '.env')).isSymbolicLink()).toBe(false);
    const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    expect(env).toContain('ANTHROPIC_API_KEY=sk-x');
    expect(env).toContain('SOME_KEY=1');
    expect(env).not.toContain('TELEGRAM_BOT_TOKEN'); // a platform token would start a gateway
    expect(fs.statSync(path.join(dir, '.env')).mode & 0o777).toBe(0o600);
    // auth.json is linked (and the link is what the first turn creates: no lstat on a missing file)
    expect(fs.lstatSync(path.join(dir, 'auth.json')).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(dir, 'auth.json'))).toBe(path.join(userHome, 'auth.json'));
    // idempotent: a second turn refreshes the prompt without duplicating the entries
    ensureAgentHome({ dataDir, agentId: 'kit', bridge: BRIDGE, systemPrompt: 'ROLE PROMPT 2' });
    const again = fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8');
    expect(again.match(/agentcraft:/g)).toHaveLength(1);
    expect(again.match(/system_prompt:/g)).toHaveLength(1);
    expect(again).toContain('system_prompt: "ROLE PROMPT 2"');
  });

  it('works when the user has no config.yaml at all', () => {
    fs.rmSync(path.join(userHome, 'config.yaml'));
    const dir = ensureAgentHome({ dataDir, agentId: 'wren', bridge: BRIDGE, systemPrompt: 'ROLE' });
    const cfg = fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8');
    expect(cfg).toContain('mcp_servers:');
    expect(cfg).toContain('  agentcraft:');
    expect(cfg).toContain('system_prompt: "ROLE"');
  });

  it('drops a gateway state left by an unfiltered run', () => {
    const dir = agentHomeDir(dataDir, 'tove');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'gateway_state.json'), JSON.stringify({ gateway_state: 'startup_failed' }));
    fs.writeFileSync(path.join(dir, 'gateway.lock'), '');
    ensureAgentHome({ dataDir, agentId: 'tove', bridge: BRIDGE, systemPrompt: 'ROLE' });
    expect(fs.existsSync(path.join(dir, 'gateway_state.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'gateway.lock'))).toBe(false);
  });
});

describe('hermes stream-json mapping', () => {
  it('turns events into monitor entries, agent state and turn stats', () => {
    const logs: Array<{ id: string; kind: string; text: string }> = [];
    const patches: Array<Record<string, unknown>> = [];
    const m = new HermesStreamMapper(stubForeman(logs, patches), 'kit', '/repo', 'worker');
    m.handle({ type: 'system', subtype: 'init' });
    m.handle({ type: 'tool_use', name: 'terminal', input: { command: 'npm test' }, tool_call_id: 'c1' });
    expect(logs.at(-1)!.text).toBe('$ npm test');
    expect(patches.at(-1)).toMatchObject({ state: 'testing', station: 'testbench' });
    m.handle({ type: 'tool_use', name: 'mcp_agentcraft_update_task', input: { task_id: 't1', status: 'review' }, tool_call_id: 'c2' });
    expect(logs.at(-1)!.text).toBe('update_task t1 review');
    m.handle({ type: 'tool_result', name: 'terminal', output: 'ok', is_error: false, tool_call_id: 'c1' });
    expect(logs.at(-1)).toMatchObject({ kind: 'result', text: 'ok' });
    m.handle({ type: 'text', text: 'Done.' });
    m.handle({ type: 'result', session_id: 'local-abc', exit_code: 0, text: 'Done.', tokens: { total: 1234 } });
    expect(m.stats.sessionId).toBe('local-abc');
    expect(m.stats.resultText).toBe('Done.');
    expect(m.stats.tokens).toBe(1234);
    expect(m.stats.isError).toBe(false);
    expect(m.stats.subtype).toBe('success');
    expect(logs.at(-1)).toMatchObject({ kind: 'result' });
  });

  it('flags a failed turn', () => {
    const m = new HermesStreamMapper(stubForeman([], []), 'kit', '/repo', 'worker');
    m.handle({ type: 'result', exit_code: 1, text: 'boom' });
    expect(m.stats.isError).toBe(true);
    expect(m.stats.subtype).toBe('error_during_execution');
    expect(m.stats.errors.join(' ')).toContain('exited 1');
  });
});

describe('team MCP bridge', () => {
  it('serves the turn tools and forwards calls to the engine socket', async () => {
    const dir = tempDir('ac-bridge-');
    const sock = path.join(dir, 'tools.sock');
    const toolsFile = path.join(dir, 'tools.json');
    fs.writeFileSync(toolsFile, JSON.stringify([{ name: 'update_task', description: 'x', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } } } }]));

    const calls: Array<{ name: string; args: unknown }> = [];
    const server = net.createServer((conn) => {
      let buf = '';
      conn.on('data', (d) => {
        buf += d.toString();
        if (!buf.includes('\n')) return;
        const req = JSON.parse(buf) as { name: string; arguments: unknown };
        calls.push({ name: req.name, args: req.arguments });
        conn.end(JSON.stringify({ result: { text: 'updated t1' } }) + '\n');
      });
    });
    await new Promise<void>((r) => server.listen(sock, () => r()));

    const child = spawn(process.execPath, [BRIDGE], {
      env: { ...process.env, AGENTCRAFT_SOCKET: sock, AGENTCRAFT_TOOLS_JSON: toolsFile },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const replies: Array<Record<string, unknown>> = [];
    let buf = '';
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        replies.push(JSON.parse(buf.slice(0, i)) as Record<string, unknown>);
        buf = buf.slice(i + 1);
      }
    });
    const send = (o: unknown) => child.stdin!.write(JSON.stringify(o) + '\n');
    const waitFor = async (id: number): Promise<any> => {
      for (let i = 0; i < 200 && !replies.some((r) => r.id === id); i++) await new Promise((r) => setTimeout(r, 20));
      return replies.find((r) => r.id === id);
    };

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    expect((await waitFor(1)).result.serverInfo.name).toBe('agentcraft');

    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect((await waitFor(2)).result.tools[0].name).toBe('update_task');

    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'update_task', arguments: { task_id: 't1', status: 'review' } } });
    expect((await waitFor(3)).result.content[0].text).toBe('updated t1');
    expect(calls).toEqual([{ name: 'update_task', args: { task_id: 't1', status: 'review' } }]);

    child.kill();
    server.close();
    rmrf(dir);
  });
});
