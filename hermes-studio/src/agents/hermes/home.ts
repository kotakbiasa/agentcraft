// Per-agent HERMES_HOME for AgentCraft turns: the agent's own Hermes config and session store.
//
// Why a home of its own per agent:
// - the team tools are an MCP server registered in config.yaml (mcp_servers); a turn must never
//   touch the user's own Hermes config
// - each agent keeps its own session store, so its turn resumes its own session across turns
//   (and across Foreman restarts: the home lives in the Foreman's profile dir)
// - the model provider's credentials ARE the user's: auth.json is symlinked in (never copied) and
//   .env is copied without its messaging-platform tokens, so an agent home never starts a gateway
//   for a platform the user's own Hermes already serves
//
// config.yaml is the user's own config (providers, models, toolsets) with two keys ensured:
// `mcp_servers.agentcraft` (the team tools) and `agent.system_prompt` (the role instructions).
// The merge is deliberately minimal and line-based: AgentCraft only ever edits its own generated
// home, and a config it cannot merge fails loudly at turn time instead of changing the user's.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HERMES_NOT_FOUND =
  'The `hermes` CLI was not found. Install Hermes Agent (https://hermes-agent.nousresearch.com/docs) or point --hermes-path at it. The sim backend still works.';

/** An executable on PATH (or an explicit path), the way the codex engine finds its CLI. */
function which(bin: string): string | undefined {
  if (bin.includes(path.sep)) {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return bin;
    } catch {
      return undefined;
    }
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

/** The hermes CLI: the configured path, `hermes` on PATH, or the usual user install location. */
export function findHermes(configured?: string): string | undefined {
  const candidates = [configured, 'hermes', path.join(os.homedir(), '.local', 'bin', 'hermes')];
  for (const c of candidates) {
    if (!c) continue;
    const found = which(c);
    if (found) return found;
  }
  return undefined;
}

/** The user's own Hermes home: credentials live here and are never modified. */
export function userHermesHome(): string {
  return process.env.HERMES_HOME ?? path.join(os.homedir(), '.hermes');
}

export function agentHomeDir(dataDir: string, agentId: string): string {
  return path.join(dataDir, `hermes-home-${agentId}`);
}

/** Tool schemas the bridge serves (written per turn by the engine). */
export function toolsJsonPath(home: string): string {
  return path.join(home, 'agentcraft-tools.json');
}

/** The engine's tool socket the bridge forwards calls to. */
export function socketPath(home: string): string {
  return path.join(home, 'agentcraft-tools.sock');
}

/** Credential keys that make a Hermes home try to serve a messaging platform. */
const PLATFORM_ENV_RE = /^(TELEGRAM|DISCORD|SLACK|WHATSAPP|SIGNAL|MATRIX|IMESSAGE|TEAMS|TWILIO|VONAGE|SMS|MESSENGER|WECHAT|LINE|VIBER|KIK|ROCKETCHAT|MATTERMOST|ZULIP|IRC|EMAIL|SMTP|IMAP)[_A-Z0-9]*$/i;

/**
 * A gateway state left behind by an earlier run of this home (before the .env was filtered) keeps
 * the CLI from starting a turn at all ("Gateway draining: not_ready"). Drop it unless it is ours.
 */
function dropStaleGatewayState(home: string): void {
  const stateFile = path.join(home, 'gateway_state.json');
  try {
    const state = (JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { gateway_state?: string }).gateway_state;
    if (!state || state === 'running') return;
    fs.rmSync(stateFile, { force: true });
    fs.rmSync(path.join(home, 'gateway.lock'), { force: true });
  } catch {
    /* no gateway state to drop */
  }
}

export interface AgentHomeOptions {
  dataDir: string;
  agentId: string;
  /** absolute path to scripts/hermes-team-mcp.mjs (spawned by hermes as the MCP server) */
  bridge: string;
  /** the role's instructions, written to agent.system_prompt */
  systemPrompt: string;
}

/** A double-quoted YAML scalar (JSON strings are valid YAML double-quoted scalars). */
function yamlString(s: string): string {
  return JSON.stringify(s);
}

/** The `agentcraft:` MCP server entry (2-space indented under `mcp_servers:`). */
function mcpBlock(home: string, bridge: string): string[] {
  return [
    '  agentcraft:',
    `    command: ${yamlString(process.execPath)}`,
    '    args:',
    `      - ${yamlString(bridge)}`,
    '    env:',
    `      AGENTCRAFT_SOCKET: ${yamlString(socketPath(home))}`,
    `      AGENTCRAFT_TOOLS_JSON: ${yamlString(toolsJsonPath(home))}`,
    '    timeout: 1800',
  ];
}

/** Lines of a top-level `key:` block (its children), as [start, end) line indexes. */
function topLevelBlock(lines: string[], key: string): { start: number; end: number } | undefined {
  const re = new RegExp(`^${key}:\\s*(#.*)?$`);
  const start = lines.findIndex((l) => re.test(l));
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < lines.length && (lines[end]!.trim() === '' || /^\s/.test(lines[end]!))) end++;
  return { start, end };
}

/**
 * The agent's config.yaml: the user's own config with `mcp_servers.agentcraft` and
 * `agent.system_prompt` ensured. Idempotent; called before every turn (the role instructions
 * change with the worktree, so the value is refreshed rather than written once).
 */
export function ensureAgentHome(o: AgentHomeOptions): string {
  const home = agentHomeDir(o.dataDir, o.agentId);
  fs.mkdirSync(home, { recursive: true });

  // Model-provider credentials: auth.json is linked, never copied (the user's own Hermes keeps
  // owning it, and it carries no messaging-platform token).
  const authSrc = path.join(userHermesHome(), 'auth.json');
  const authDst = path.join(home, 'auth.json');
  if (fs.existsSync(authSrc)) {
    let linked = false;
    try {
      linked = fs.lstatSync(authDst).isSymbolicLink() && fs.readlinkSync(authDst) === authSrc;
    } catch {
      linked = false; // not linked yet: this agent's first turn
    }
    if (!linked) {
      try {
        fs.rmSync(authDst, { force: true });
        fs.symlinkSync(authSrc, authDst);
      } catch (e) {
        throw new Error(`could not link auth.json into ${home}: ${(e as Error).message}`);
      }
    }
  }
  // .env: a FILTERED copy, not a link. The agent needs the model provider's keys, but a messaging
  // platform token would make the CLI auto-start a gateway for this home - and that fails
  // ("Gateway draining: not_ready") because the user's own gateway already owns the bot token.
  // Platform credentials are left out: an agent home never serves a platform.
  const envSrc = path.join(userHermesHome(), '.env');
  if (fs.existsSync(envSrc)) {
    const kept = fs
      .readFileSync(envSrc, 'utf8')
      .split('\n')
      .filter((l) => !PLATFORM_ENV_RE.test(l.split('=')[0]!.trim().replace(/^export\s+/i, '')))
      .join('\n');
    const envDst = path.join(home, '.env');
    fs.writeFileSync(envDst, kept, { mode: 0o600 });
    try {
      fs.chmodSync(envDst, 0o600);
    } catch {
      /* best effort */
    }
  }
  dropStaleGatewayState(home);

  // config.yaml: the user's config + our MCP server + the role instructions.
  const userConfig = path.join(userHermesHome(), 'config.yaml');
  let base = '';
  try {
    base = fs.readFileSync(userConfig, 'utf8');
  } catch {
    base = '# AgentCraft agent home (the user has no Hermes config.yaml; defaults apply)\n';
  }
  const lines = base.replace(/\r\n/g, '\n').split('\n');

  // mcp_servers: drop a previous agentcraft entry, then insert ours at the head of the block.
  const mcp = topLevelBlock(lines, 'mcp_servers');
  if (mcp) {
    const block = mcpBlock(home, o.bridge);
    const inner = lines.slice(mcp.start + 1, mcp.end);
    const kept: string[] = [];
    for (let i = 0; i < inner.length; i++) {
      const l = inner[i]!;
      if (/^\s{2}agentcraft:\s*(#.*)?$/.test(l)) {
        i++;
        while (i < inner.length && (/^\s{4}/.test(inner[i]!) || inner[i]!.trim() === '')) i++;
        i--;
        continue;
      }
      kept.push(l);
    }
    lines.splice(mcp.start + 1, mcp.end - mcp.start - 1, ...block, ...kept);
  } else {
    // append the whole block at the top level
    lines.push('mcp_servers:', ...mcpBlock(home, o.bridge));
  }

  // agent.system_prompt: replace the key if the agent block has one, else add it to the block.
  const promptLine = `  system_prompt: ${yamlString(o.systemPrompt)}`;
  const agent = topLevelBlock(lines, 'agent');
  if (agent) {
    const idx = lines.findIndex((l, i) => i > agent.start && i < agent.end && /^\s+system_prompt:\s/.test(l));
    if (idx >= 0) lines[idx] = promptLine;
    else lines.splice(agent.start + 1, 0, promptLine);
  } else {
    lines.push('agent:', promptLine);
  }

  fs.writeFileSync(path.join(home, 'config.yaml'), lines.join('\n'));
  return home;
}
