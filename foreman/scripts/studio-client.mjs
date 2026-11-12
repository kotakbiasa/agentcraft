// A headless console for the studio — connects to the Foreman over the protocol v1 WebSocket
// (docs/protocol.md) and prints what the team is doing, exactly like the mod's terminal does in
// game. Useful for CI smoke runs, for driving the Foreman without Minecraft, and for scripting
// goals and decisions from the shell.
//
//   node scripts/studio-client.mjs                              # snapshot + stream for 30s
//   node scripts/studio-client.mjs --watch 300                   # stream for 5 min
//   node scripts/studio-client.mjs --goal "Add a --version flag"
//   node scripts/studio-client.mjs --answer d2 Merge              # Merge | Request changes | Reject
//   node scripts/studio-client.mjs --port 7878 --repo notes
//
// The Foreman rejects connections that look like browser pages (an Origin header means a 401),
// so a plain Node client can always connect. Env: AGENTCRAFT_PORT.
import WebSocket from 'ws';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`studio-client — talk to a running Foreman over protocol v1

  --port <n>          Foreman port (default $AGENTCRAFT_PORT or 7878)
  --watch <seconds>   how long to stream before exiting (default 30, 0 = forever)
  --goal <text>       submit a goal as soon as the snapshot arrives
  --repo <id>         repo id for --goal (default: the Foreman's only repo)
  --answer <id> <opt> answer a decision (Merge | Request changes | Reject)
  --quiet             snapshot only, no live stream
  --help              this text`);
  process.exit(0);
}

const port = flag('port', process.env.AGENTCRAFT_PORT ?? '7878');
const watchS = Number(flag('watch', '30'));
const quiet = argv.includes('--quiet');
const goal = flag('goal', undefined);
const repo = flag('repo', undefined);
const answerIdx = argv.indexOf('--answer');
const answer = answerIdx >= 0 ? argv[answerIdx + 1] : undefined;
const answerOption = answerIdx >= 0 ? argv[answerIdx + 2] : undefined;
if (answer && !answerOption) {
  console.error('--answer needs a decision id and an option: --answer d2 Merge');
  process.exit(2);
}

const ws = new WebSocket(`ws://127.0.0.1:${port}`);
let id = 0;
const send = (msg) => ws.send(JSON.stringify({ v: 1, id: `c${++id}`, ...msg }));
const t0 = Date.now();
const at = () => `+${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s`;
const line = (...parts) => console.log(at(), ...parts);
const oneLine = (s, n = 150) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

ws.on('open', () => {
  line('connected to', `ws://127.0.0.1:${port}`);
  send({ type: 'hello', modVersion: 'studio-client', protocol: 1, client: 'cli' });
});

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  switch (m.type) {
    case 'snapshot': {
      const f = m.foreman ?? {};
      line(`snapshot: backend=${f.backend} auth=${f.auth} account=${f.account ?? '-'} repo(s)=${(m.repos ?? []).map((r) => r.id).join(',') || '-'}`);
      line(`  team: ${(m.agents ?? []).filter((a) => a.active).map((a) => `${a.name}(${a.engine ?? 'sim'}/${a.model ?? '?'})`).join(' ') || '-'}`);
      line(`  goals: ${(m.goals ?? []).map((g) => `${g.id} ${g.status} ${Math.round((g.progress ?? 0) * 100)}%`).join(' ') || 'none'}`);
      for (const t of m.tasks ?? []) line(`  task ${t.id} [${t.status}] ${t.assignee ?? '-'} ci=${t.ci ?? '-'} :: ${t.title}`);
      for (const d of m.decisions ?? []) line(`  DECISION ${d.id} ${d.kind} ${d.status}: ${d.question}`);
      if (quiet) {
        ws.close();
        process.exit(0);
      }
      if (goal) send({ type: 'goal.submit', text: goal, repoId: repo });
      if (answer) send({ type: 'decision.answer', decisionId: answer, option: answerOption });
      break;
    }
    case 'agent.upsert': {
      const a = m.agent;
      if (a) line(`agent ${a.id}: ${a.state} @${a.station} - ${oneLine(a.activity, 90)}${a.model ? ` [${a.model}]` : ''}`);
      break;
    }
    case 'agent.log': {
      for (const e of m.entries ?? []) line(`  log ${m.agentId} ${e.kind}: ${oneLine(e.text)}`);
      break;
    }
    case 'task.upsert': {
      if (m.task) line(`TASK ${m.task.id} [${m.task.status}] ${m.task.assignee ?? '-'} ci=${m.task.ci ?? '-'} :: ${m.task.title}`);
      break;
    }
    case 'decision.upsert': {
      if (m.decision) line(`DECISION ${m.decision.id} ${m.decision.kind} ${m.decision.status}: ${m.decision.question}`);
      break;
    }
    case 'feed.add': {
      if (m.item) line(`FEED ${m.item.kind}: ${oneLine(m.item.text, 140)}`);
      break;
    }
    case 'foreman.status': {
      if (m.status) line(`status: auth=${m.status.auth} account=${m.status.account ?? '-'} ${oneLine(m.status.message, 120)}`);
      break;
    }
    case 'ack':
      if (!m.ok) line('ACK FAILED:', m.error ?? JSON.stringify(m));
      else line(`ack ok (${m.re ?? m.id ?? '?'})`);
      break;
    case 'error':
      line('ERROR from Foreman:', oneLine(m.message ?? m.error ?? JSON.stringify(m), 200));
      break;
    default:
      break;
  }
});

ws.on('error', (e) => {
  console.error(`ws error: ${e.message} (is the Foreman running on port ${port}?)`);
  process.exitCode = 1;
});
ws.on('close', () => line('disconnected'));

if (watchS > 0) {
  setTimeout(() => {
    line('done watching');
    ws.close();
    process.exit(process.exitCode ?? 0);
  }, watchS * 1000).unref();
}
