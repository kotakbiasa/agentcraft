// Map Hermes `--format stream-json` events -> agent.log entries + agent state/station
// (like codex/stream.ts).
//
// The CLI prints one JSON object per line; anything else (its "Session: <id>" banner, stray
// warnings) is ignored by the engine's line reader. Event types seen in practice:
//   system/init, tool_use {name, input, tool_call_id}, tool_result {output, is_error, duration_ms},
//   text {text} (streaming deltas, many per answer), result {session_id, exit_code, text, tokens}
import type { Foreman } from '../../foreman.js';
import { firstLine, headLines, truncate } from '../../util/text.js';
import { toolActivity } from '../activity.js';
import type { Role, TurnStats } from '../engine.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type HermesEvent = { type?: string; [k: string]: any };

/** Hermes built-in tool -> the Claude tool vocabulary activity.ts knows. */
const TOOL_ALIASES: Record<string, string> = {
  terminal: 'Bash',
  read_file: 'Read',
  write_file: 'Write',
  patch: 'Edit',
  search_files: 'Grep',
  web_search: 'WebSearch',
  web_extract: 'WebFetch',
};

const TEAM_PREFIX = 'mcp_agentcraft_';

/** `mcp_agentcraft_update_task` -> `update_task` (the team tools AgentCraft serves). */
export function teamToolName(name: string): string | undefined {
  if (name.startsWith(TEAM_PREFIX)) return name.slice(TEAM_PREFIX.length);
  // Hermes' own MCP registry names the same server's tools `mcp__agentcraft__<tool>`
  const alt = 'mcp__agentcraft__';
  return name.startsWith(alt) ? name.slice(alt.length) : undefined;
}

export class HermesStreamMapper {
  readonly stats: TurnStats = { isError: false, errors: [] };
  private steps = 0;
  private text = '';
  private finalText: string | undefined;

  constructor(
    private fm: Foreman,
    private agentId: string,
    private cwd: string,
    private role: Role,
  ) {}

  private set(patch: { state?: any; station?: any; activity?: string }): void {
    const a = this.fm.agent(this.agentId);
    // a pending question/permission keeps the agent at the user
    if (a?.state === 'waiting_user' && patch.state !== 'waiting_user') return;
    this.fm.setAgent(this.agentId, patch);
  }

  private refreshSoon(): void {
    if (this.role !== 'worker') return;
    const repoId = this.fm.agent(this.agentId)?.repoId;
    if (repoId) this.fm.repos.scheduleRefresh(repoId, 1500);
  }

  /** The streamed prose of the current answer becomes one monitor entry. */
  private flushText(): void {
    const text = this.text.trim();
    this.text = '';
    if (!text) return;
    this.fm.agentLog(this.agentId, 'text', truncate(text, 1200));
    this.set({ state: 'thinking', activity: firstLine(text, 48) });
  }

  handle(ev: HermesEvent): void {
    const fm = this.fm;
    const id = this.agentId;
    switch (ev.type) {
      case 'system': {
        if (ev.subtype === 'init') fm.agentLog(id, 'text', `Hermes session ready${ev.model ? ` (${ev.model})` : ''}`);
        break;
      }
      case 'tool_use': {
        this.flushText();
        this.steps++;
        const name = String(ev.name ?? '?');
        const input = (ev.input ?? {}) as Record<string, unknown>;
        const team = teamToolName(name);
        const act = toolActivity(team ?? TOOL_ALIASES[name] ?? name, input, this.cwd);
        fm.agentLog(id, 'tool', act.label);
        this.set({ state: act.state, station: act.station, activity: act.activity });
        this.refreshSoon();
        break;
      }
      case 'tool_result': {
        const out = typeof ev.output === 'string' ? ev.output : JSON.stringify(ev.output ?? '');
        if (ev.is_error) fm.agentLog(id, 'error', truncate(out || 'tool error', 600));
        else fm.agentLog(id, 'result', headLines(out, 3, 300) || 'ok');
        this.refreshSoon();
        break;
      }
      case 'text': {
        this.text += String(ev.text ?? '');
        break;
      }
      case 'error': {
        const msg = String(ev.message ?? ev.error ?? 'error');
        fm.agentLog(id, 'error', truncate(msg, 400));
        this.stats.errors.push(msg);
        break;
      }
      case 'result': {
        this.flushText();
        const sid = typeof ev.session_id === 'string' && ev.session_id ? ev.session_id : undefined;
        if (sid) this.stats.sessionId = sid;
        const text = typeof ev.text === 'string' ? ev.text.trim() : '';
        if (text) this.finalText = text;
        this.stats.resultText = this.finalText;
        const tokens = (ev.tokens ?? {}) as { total?: number };
        if (typeof tokens.total === 'number') this.stats.tokens = tokens.total;
        this.stats.numTurns = this.steps;
        const code = typeof ev.exit_code === 'number' ? ev.exit_code : 0;
        this.stats.isError = code !== 0;
        this.stats.subtype = code === 0 ? 'success' : 'error_during_execution';
        if (code !== 0) this.stats.errors.push(`hermes exited ${code}`);
        const tok = this.stats.tokens ? ` · ${Math.round(this.stats.tokens / 1000)}k tokens` : '';
        fm.agentLog(id, this.stats.isError ? 'error' : 'result', `turn ${code === 0 ? 'complete' : `failed (exit ${code})`} (${this.steps} steps${tok})`);
        break;
      }
      default:
        break; // unknown event: ignore
    }
  }
}
