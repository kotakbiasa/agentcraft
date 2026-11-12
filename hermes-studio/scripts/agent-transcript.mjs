#!/usr/bin/env node
// Read what the agents actually said, without touching the user's own Hermes state.
//
// Each agent keeps its own Hermes home (<AGENTCRAFT_HOME>/hermes-home-<agent>) and its sessions
// live in that home's state.db. That store cannot be shared with the user's own
// (~/.hermes/state.db): Hermes' file-state guard refuses to keep writing once a store it opened is
// replaced, so pointing an agent at the user's store breaks its turns. Reading it, on the other
// hand, is harmless — that is this script.
//
//   node scripts/agent-transcript.mjs --list                  # every agent that has a store
//   node scripts/agent-transcript.mjs --agent marlow          # the latest session, fully
//   node scripts/agent-transcript.mjs --agent kit --tools     # include tool calls/results
//   node scripts/agent-transcript.mjs --agent wren --session <id> --limit 40
//
// Data dir comes from --data or AGENTCRAFT_HOME (default ~/.hermes-studio), the same default the
// service uses.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};

if (flag('help') || flag('h')) {
  console.log(`agent-transcript — read an AgentCraft agent's Hermes sessions (read-only)

  --data <dir>        state dir (default $AGENTCRAFT_HOME or ~/.hermes-studio)
  --agent <id>        agent whose transcript to read (marlow, kit, wren, ...)
  --session <id>      a specific session (default: the most recent one)
  --limit <n>         how many messages to print (default 60, newest kept)
  --tools             include tool calls and their results
  --list              list the agents that have a session store
  --help              this text`);
  process.exit(0);
}

const dataDir = opt('data', process.env.AGENTCRAFT_HOME ?? path.join(os.homedir(), '.hermes-studio'));
const limit = Number(opt('limit', '60'));
const withTools = flag('tools');

const homes = () =>
  fs
    .readdirSync(dataDir)
    .filter((d) => d.startsWith('hermes-home-'))
    .map((d) => ({ agent: d.slice('hermes-home-'.length), db: path.join(dataDir, d, 'state.db') }))
    .filter((h) => fs.existsSync(h.db));

if (!fs.existsSync(dataDir)) {
  console.error(`no state dir at ${dataDir} (pass --data or set AGENTCRAFT_HOME)`);
  process.exit(1);
}

const agents = homes();
if (flag('list') || !opt('agent')) {
  if (!agents.length) {
    console.error(`no agent has run yet under ${dataDir}`);
    process.exit(1);
  }
  console.log(`agents under ${dataDir}:`);
  for (const a of agents) {
    let n = '?';
    let last = '';
    try {
      const db = new DatabaseSync(a.db, { readOnly: true });
      n = String(db.prepare('SELECT count(*) AS n FROM sessions').get().n);
      last = db.prepare('SELECT COALESCE(title, id) AS t, started_at FROM sessions ORDER BY started_at DESC LIMIT 1').get()?.t ?? '';
      db.close();
    } catch {
      /* an unreadable store still gets listed */
    }
    console.log(`  ${a.agent.padEnd(8)} ${n.padStart(4)} session(s)   ${last.slice(0, 60)}`);
  }
  if (!opt('agent')) console.log('\npick one with --agent <id>');
  process.exit(0);
}

const target = agents.find((a) => a.agent === opt('agent'));
if (!target) {
  console.error(`no session store for "${opt('agent')}" under ${dataDir}${agents.length ? ` (have: ${agents.map((a) => a.agent).join(', ')})` : ''}`);
  process.exit(1);
}

const db = new DatabaseSync(target.db, { readOnly: true });
const sessionId = opt('session');
const session = sessionId
  ? db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId)
  : db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT 1').get();
if (!session) {
  console.error(`no session${sessionId ? ` ${sessionId}` : ''} for ${target.agent}`);
  process.exit(1);
}

const when = (s) => (s ? new Date(s * 1000).toISOString().replace('T', ' ').slice(0, 19) : '-');
console.log(`agent ${target.agent} · session ${session.id}`);
console.log(`  model     ${session.model ?? '?'}`);
console.log(`  messages  ${session.message_count ?? '?'} (${session.tool_call_count ?? '?'} tool calls)`);
console.log(`  started   ${when(session.started_at)}  ended ${session.end_reason ?? '-'}`);
if (session.title) console.log(`  title     ${session.title}`);
console.log('');

const rows = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY rowid').all(session.id);
const shown = rows.slice(-limit);
if (rows.length > shown.length) console.log(`… ${rows.length - shown.length} earlier message(s) omitted (--limit ${limit})\n`);

const oneLine = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
for (const m of shown) {
  const role = m.role ?? '?';
  const tool = m.tool_name ? ` [${m.tool_name}]` : '';
  if (m.tool_name && !withTools) continue;
  let body = m.content ?? '';
  if (!body && m.tool_calls) {
    try {
      const calls = JSON.parse(m.tool_calls);
      body = (Array.isArray(calls) ? calls : [calls])
        .map((c) => `${c.name ?? c.function?.name ?? '?'}(${oneLine(JSON.stringify(c.arguments ?? c.function?.arguments ?? {}), 120)})`)
        .join(' ');
    } catch {
      body = String(m.tool_calls);
    }
  }
  if (!body) continue;
  console.log(`${role}${tool}  ${oneLine(body, withTools ? 400 : 700)}`);
}
db.close();
