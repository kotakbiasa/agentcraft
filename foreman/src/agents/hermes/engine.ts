// The Hermes engine: one `hermes chat --oneshot` process per turn (the same shape as the Codex
// engine's one `codex app-server` per turn). The agent's Hermes session is durable (its id is the
// session id), so a later turn resumes it in a new process.
//
// What the agent may do is decided like the other engines:
// - the team tools (send_message, ask_user, update_task...) are an MCP server ("agentcraft")
//   registered in the agent's own HERMES_HOME config (see home.ts). Hermes spawns the bridge
//   (scripts/hermes-team-mcp.mjs), which forwards every call over a Unix socket to this engine,
//   where it runs against the live turn's handlers - so ask_user really blocks the turn.
// - commands run with the git safety environment (no push, no hooks, the agent's own identity),
//   passed explicitly because the agent process inherits this environment.
// - the agent works in its own worktree (spec.cwd); the lead works in the user's checkout.
// - the role's instructions are written to the agent home's `agent.system_prompt`, so they apply
//   to every turn without being repeated in each query.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import type { HermesConfig } from '../../config.js';
import type { Foreman } from '../../foreman.js';
import { truncate } from '../../util/text.js';
import { userName } from '../../user.js';
import type { AuthCheck, Engine, Role, TurnSpec, TurnStats } from '../engine.js';
import type { AgentTool, TurnHandle } from '../tools.js';
import { ensureAgentHome, findHermes, HERMES_NOT_FOUND, socketPath, toolsJsonPath } from './home.js';
import { HermesStreamMapper } from './stream.js';

export interface HermesEngineOptions {
  /** the hermes CLI (tests: node with a fake script in `args`) */
  bin?: string;
  /** arguments before `chat` */
  args?: string[];
}

/** Extra instructions for a Hermes agent: the team tools by their real (prefixed) names. */
function notes(role: Role, tools: AgentTool[]): string {
  return [
    '',
    '# Working in AgentCraft (Hermes)',
    `- The AgentCraft team tools (${tools.map((t) => `mcp_agentcraft_${t.name}`).join(', ')}) are MCP tools: call them directly by those names. They are how the team and ${userName()} see your work; plain text only shows on your monitor.`,
    '- Your commands run in your own directory with git safety on: no push, no signing, no hooks, and commits carry your own AgentCraft identity.',
    `- Do not spawn sub-agents. Do not use your own memory tools: use mcp_agentcraft_write_memory / mcp_agentcraft_read_memory so the team sees it. Ask ${userName()} only with mcp_agentcraft_ask_user.`,
    role === 'lead' ? '- You are read-only: never modify files or run commands that change anything.' : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class HermesEngine implements Engine {
  readonly id = 'hermes' as const;
  readonly label = 'Hermes';
  /** the model in the user's Hermes config (learned at the auth check) */
  private configuredModel: string | undefined;

  constructor(
    private fm: Foreman,
    private cfg: HermesConfig,
    private opts: HermesEngineOptions = {},
  ) {}

  private bin(): string | undefined {
    return this.opts.bin ?? findHermes(this.cfg.path);
  }

  model(role: Role): string {
    return (role === 'lead' ? this.cfg.leadModel : this.cfg.workerModel) ?? this.configuredModel ?? 'default';
  }

  authFailedMessage(detail: string): string {
    return `Hermes authentication failed (${detail}). Check \`hermes status\` (or \`hermes login\`), then restart the Foreman. The sim backend still works.`;
  }

  async checkAuth(): Promise<AuthCheck> {
    const bin = this.bin();
    if (!bin) return { ok: false, message: HERMES_NOT_FOUND };
    return await new Promise<AuthCheck>((resolve) => {
      let out = '';
      let done = false;
      const finish = (r: AuthCheck) => {
        if (done) return;
        done = true;
        resolve(r);
      };
      const child = spawn(bin, ['status'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      const cap = (d: Buffer) => {
        out += d.toString('utf8');
        if (out.length > 8000) out = out.slice(-8000);
      };
      child.stdout?.on('data', cap);
      child.stderr?.on('data', cap);
      child.on('error', () => finish({ ok: false, message: `Hermes check failed: could not run ${bin}. The sim backend still works.` }));
      const timer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
        finish({ ok: false, message: 'Hermes check timed out (`hermes status`).' });
      }, 30_000);
      timer.unref?.();
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          const model = /model[^\n:]*:\s*(?!custom)([^\s,]+)/i.exec(out)?.[1];
          if (model) this.configuredModel ??= model;
          finish({ ok: true, account: this.configuredModel ? `hermes (${this.configuredModel})` : 'hermes' });
        } else {
          const last = out.trim().split('\n').filter(Boolean).slice(-2).join(' ');
          finish({ ok: false, message: `Hermes is not ready (\`hermes status\` exited ${code}).${last ? ` ${truncate(last, 200)}` : ''} The sim backend still works.` });
        }
      });
    });
  }

  /** The turn's tool socket: the bridge calls in here, the handlers run in this process. */
  private toolServer(home: string, tools: Map<string, AgentTool>, turn: TurnHandle): Promise<{ close(): void }> {
    return new Promise((resolve, reject) => {
      const sock = socketPath(home);
      try {
        fs.rmSync(sock, { force: true });
      } catch {
        /* no stale socket */
      }
      const server = net.createServer((conn) => {
        let buf = '';
        conn.on('data', (d) => {
          buf += d.toString('utf8');
          const nl = buf.indexOf('\n');
          if (nl < 0) return;
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          void this.callTool(line, tools, turn)
            .then((res) => conn.end(JSON.stringify({ result: res }) + '\n'))
            .catch((e: unknown) => conn.end(JSON.stringify({ error: errorText(e) }) + '\n'));
        });
        conn.on('error', () => {
          /* the bridge went away: nothing to do */
        });
      });
      server.on('error', reject);
      server.listen(sock, () =>
        resolve({
          close: () => {
            try {
              server.close();
            } catch {
              /* already closed */
            }
            try {
              fs.rmSync(sock, { force: true });
            } catch {
              /* already gone */
            }
          },
        }),
      );
    });
  }

  /** One bridge call -> the turn's AgentTool handler (which may block on the user, e.g. ask_user). */
  private async callTool(line: string, tools: Map<string, AgentTool>, turn: TurnHandle): Promise<{ text: string; isError?: boolean }> {
    const req = JSON.parse(line) as { name?: string; arguments?: Record<string, unknown> };
    const t = tools.get(String(req.name));
    if (!t) return { text: `Unknown tool ${req.name}`, isError: true };
    // a stopped/aborted turn must not change anything any more
    if (turn.signal.aborted) return { text: 'your turn was stopped; nothing was changed', isError: true };
    const parsed = z.object(t.shape).safeParse(req.arguments ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
      return { text: `Invalid arguments for ${t.name}: ${issues}`, isError: true };
    }
    const res = await t.handler(parsed.data);
    return { text: res.content.map((c) => c.text).join('\n'), ...(res.isError ? { isError: true } : {}) };
  }

  async runTurn(spec: TurnSpec): Promise<TurnStats> {
    const bin = this.bin();
    if (!bin) throw new Error(HERMES_NOT_FOUND);
    const { agentId, role, cwd, abort } = spec;
    const mapper = new HermesStreamMapper(this.fm, agentId, cwd, role);

    // the agent's own Hermes home: config (team MCP + role instructions), symlinked credentials
    const bridge = path.join(this.fm.config.projectRoot, 'foreman', 'scripts', 'hermes-team-mcp.mjs');
    const home = ensureAgentHome({
      dataDir: this.fm.config.dataDir,
      agentId,
      bridge,
      systemPrompt: spec.instructions + notes(role, spec.tools),
    });
    // the schemas the bridge serves for THIS turn (the turn's tools are the live ones)
    const schemas = spec.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(z.object(t.shape)) }));
    fs.writeFileSync(toolsJsonPath(home), JSON.stringify(schemas, null, 2));

    const tools = new Map(spec.tools.map((t) => [t.name, t]));
    const server = await this.toolServer(home, tools, spec.turn);

    // the query goes through a file: nothing is shell-interpreted, so arbitrary text is safe
    const promptFile = path.join(home, 'turn-prompt.txt');
    fs.writeFileSync(promptFile, spec.prompt);

    const args = ['chat', '--oneshot', '--format', 'stream-json', '--in', cwd, '--query-file', promptFile, '--pass-session-id'];
    if (spec.resume) args.push('--resume', spec.resume);
    const model = role === 'lead' ? this.cfg.leadModel : this.cfg.workerModel;
    if (model) args.push('--model', model);
    const effort = role === 'lead' ? this.cfg.leadEffort : this.cfg.effort;
    if (effort) args.push('--reasoning', effort);
    const maxTurns = role === 'lead' ? this.fm.config.claude.maxTurnsLead : this.fm.config.claude.maxTurnsWorker;
    if (maxTurns) args.push('--max-turns', String(maxTurns));
    if (this.cfg.yolo) args.push('--yolo');

    const child: ChildProcess = spawn(bin, [...(this.opts.args ?? []), ...args], {
      cwd,
      env: { ...spec.env, HERMES_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    spec.onProcess(child);

    const rl = readline.createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      const text = line.trim();
      if (!text) return;
      // the CLI also prints a plain "Session: <id>" banner: the earliest place to learn the id
      const banner = /^Session:\s+(\S+)/.exec(text);
      if (banner) {
        if (!mapper.stats.sessionId) {
          mapper.stats.sessionId = banner[1];
          spec.onSession(banner[1]!);
        }
        return;
      }
      if (!text.startsWith('{')) return; // a plain log line: ignore
      let ev: unknown;
      try {
        ev = JSON.parse(text);
      } catch {
        return;
      }
      mapper.handle(ev as { type?: string });
      const sid = (ev as { type?: string; session_id?: unknown }).session_id;
      if (typeof sid === 'string' && sid) spec.onSession(sid);
    });
    child.stderr?.on('data', (d: Buffer) => this.fm.log.debug(`[${agentId} hermes] ${d.toString().trim().slice(0, 300)}`));

    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
    child.on('error', (e) => {
      mapper.stats.errors.push(errorText(e));
      mapper.stats.isError = true;
      mapper.stats.subtype = 'error_during_execution';
    });
    const onAbort = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 3000);
      t.unref?.();
    };
    if (abort.signal.aborted) onAbort();
    else abort.signal.addEventListener('abort', onAbort, { once: true });

    try {
      await exited;
    } finally {
      abort.signal.removeEventListener('abort', onAbort);
      rl.close();
      server.close();
      fs.rmSync(promptFile, { force: true });
    }
    return mapper.stats;
  }
}
