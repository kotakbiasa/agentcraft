#!/usr/bin/env node
// hermes-studio — the Hermes-native AgentCraft backend.
//
// Replaces the Foreman process: same protocol v1 to the mod, same repo/worktree/merge safety,
// but the brain is a Hermes turn (the lead), not hardcoded orchestration.
//
//   node hermes-studio/dist/src/index.js \
//     --repo ~/Projects/demo --goal "add a --version flag" --auto-merge demo
//
// Env: AGENTCRAFT_HOME (state dir, default ~/.hermes-studio), HERMES_BIN / HERMES_ARGS.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HermesStudio } from './studio.js';
import type { StudioConfig } from './types.js';

const USAGE = `hermes-studio — Hermes-native AgentCraft backend

  --repo <path>          register a local git repo (repeatable)
  --goal <text>          submit a goal to the lead right away
  --port <n>             protocol port (default 7878)
  --data <dir>           state dir: AGENTCRAFT_HOME (default ~/.hermes-studio)
  --workers <a,b>        workers on shift (default: kit,wren)
  --model <m>            model for every agent
  --lead-model <m>       model for the lead
  --worker-model <m>     model for the workers
  --effort <e>           thinking effort (low|medium|high)
  --yolo                 let agents run without the tool gate asking first
  --auto-merge <id|all>  merge green CI without asking (experiment repos; repeatable)
  --user-name <name>     what the agents call you (default: your git name or "boss")
  --project-root <dir>   repo root (default: derived from this file)
  --help                 this text
`;

function parseArgv(argv: string[]): { opts: Record<string, string[]>; flags: Set<string> } {
  const opts: Record<string, string[]> = {};
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--help' || a === '-h' || a === '--yolo') {
      flags.add(a.replace(/^--?/, ''));
      continue;
    }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        (opts[key] ??= []).push(next);
        i++;
      } else {
        (opts[key] ??= []).push('true');
      }
    }
  }
  return { opts, flags };
}

const one = (o: Record<string, string[]>, k: string): string | undefined => o[k]?.[0];

/** Walk up from this file until the directory that holds hermes-studio/scripts/team-mcp.mjs. */
function findProjectRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'hermes-studio', 'scripts', 'team-mcp.mjs'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // dist/src/index.js -> <root>/hermes-studio/dist/src
  return path.resolve(from, '..', '..', '..');
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<HermesStudio> {
  const { opts, flags } = parseArgv(argv);
  if (flags.has('help')) {
    console.log(USAGE);
    process.exit(0);
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = one(opts, 'project-root') ?? findProjectRoot(here);
  const dataDir = one(opts, 'data') ?? process.env.AGENTCRAFT_HOME ?? path.join(os.homedir(), '.hermes-studio');
  fs.mkdirSync(dataDir, { recursive: true });

  const workers = new Set((one(opts, 'workers') ?? 'kit,wren').split(',').map((s) => s.trim()).filter(Boolean));

  const config: StudioConfig = {
    projectRoot,
    dataDir,
    port: Number(one(opts, 'port') ?? process.env.AGENTCRAFT_PORT ?? 7878),
    maxTurnsLead: Number(one(opts, 'lead-turns') ?? 30),
    maxTurnsWorker: Number(one(opts, 'worker-turns') ?? 40),
    leadModel: one(opts, 'lead-model') ?? one(opts, 'model'),
    workerModel: one(opts, 'worker-model') ?? one(opts, 'model'),
    effort: one(opts, 'effort'),
    leadEffort: one(opts, 'lead-effort') ?? one(opts, 'effort'),
    yolo: flags.has('yolo'),
    autoMerge: new Set((opts['auto-merge'] ?? []).flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean)),
    userName: one(opts, 'user-name') ?? os.userInfo().username,
    workers,
  };

  const studio = new HermesStudio(config);
  await studio.start();

  for (const p of opts.repo ?? []) await studio.addRepo(path.resolve(p));
  // with the repos known, any task left over from a previous run can be started again
  studio.assignOpenTasks();
  studio.recoverReviews();
  studio.recoverPlanning();
  if (one(opts, 'goal')) await studio.submitGoal(String(one(opts, 'goal')));

  const shutdown = () => {
    studio.log.info('stopping');
    studio.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(
    [
      `hermes-studio up — protocol v1 on ws://127.0.0.1:${config.port}`,
      `  project   ${config.projectRoot}`,
      `  state     ${config.dataDir}`,
      `  workers   ${[...workers].join(', ') || '(none)'}`,
      `  models    lead=${config.leadModel ?? 'default'} worker=${config.workerModel ?? 'default'}`,
      `  merge     ${config.autoMerge.size ? [...config.autoMerge].join(', ') : '(user approves every merge)'}`,
    ].join('\n'),
  );
  return studio;
}

const invokedDirectly = (() => {
  const self = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
  return self === fs.realpathSync(fileURLToPath(import.meta.url));
})();
if (invokedDirectly) void main();
