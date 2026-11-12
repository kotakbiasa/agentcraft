// The Hermes-native studio: the Foreman's job, minus its brain.
//
// One process owns everything the mod talks to (protocol v1 on ws://127.0.0.1:7878), the repos
// with their git worktrees and merges, the task board, shared memory, and one Hermes engine that
// runs every agent turn (`hermes chat --oneshot`, one session per agent, a HERMES_HOME per agent).
//
// There is no hardcoded orchestration loop: the lead's turn is a Hermes turn like any other. It
// reads the goal, plans in shared memory, and calls `create_task`; a worker turn picks the task
// up in its own worktree; CI runs when a task goes to review; a merge happens when CI is green
// and either the user approved it or the repo is an experiment repo with auto-merge on. What the
// code enforces is only the safety part: worktrees, no pushes, no signing, tool gates, and the
// fact that nothing merges into a real repo without a human yes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { consoleLogger, type Ctx, type Logger } from './context.js';
import { Store } from './store.js';
import { RepoManager } from './repos.js';
import { classifyToolUse, type PolicyContext } from './policy.js';
import { loadCast, LEAD_ID, type CastMember } from './cast.js';
import { withGitSafety } from './gitsafety.js';
import { agentGitIdentity } from './util/git.js';
import { HermesEngine } from './agents/hermes/engine.js';
import { agentTools } from './tools.js';
import { ProtocolServer } from './server.js';
import { MERGE_OPTIONS } from './protocol.js';
import type {
  Engine,
  PermissionGate,
  Role,
  StudioConfig,
  ToolHooks,
  TurnHandle,
  TurnSpec,
  TurnStats,
} from './types.js';
import type { Agent, AuthStatus, Decision, FeedKind, Goal, MemoryEntry, Outbound, Task } from './protocol.js';

/** Hermes tool names the policy engine does not know, mapped to the Claude vocabulary it does. */
const TOOL_ALIASES: Record<string, string> = {
  terminal: 'Bash',
  read_file: 'Read',
  write_file: 'Write',
  patch: 'Edit',
  search_files: 'Grep',
  list_files: 'LS',
  fetch_url: 'WebFetch',
  web_search: 'WebSearch',
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'note';

/** A turn handle a tool can read to learn why its turn is ending. */
class SimpleTurn {
  readonly controller = new AbortController();
  reasonText?: string;
  constructor() {
    this.controller.signal.addEventListener('abort', () => {
      this.reasonText ??= 'stopped';
    });
  }
  reason(): string | undefined {
    return this.reasonText;
  }
  get signal(): AbortSignal {
    return this.controller.signal;
  }
}

const STUDIO_VERSION = 'hermes-studio 0.1';

export class HermesStudio {
  readonly config: StudioConfig;
  readonly store: Store;
  readonly log: Logger;
  readonly repos: RepoManager;
  readonly engine: Engine;

  private server?: ProtocolServer;
  private cast: CastMember[];
  /** one turn at a time per agent, in arrival order */
  private queues = new Map<string, Promise<unknown>>();
  private aborters = new Map<string, AbortController>();
  private turns = new Map<string, SimpleTurn>();
  private decisionWaiters = new Map<string, (text: string | undefined) => void>();
  private msgN = 0;
  private auth: AuthStatus = 'checking';
  private account?: string;
  private backendMessage?: string;

  constructor(config: StudioConfig, opts: { log?: Logger } = {}) {
    this.config = config;
    this.log = opts.log ?? consoleLogger('hermes-studio', { debug: process.env.AGENTCRAFT_DEBUG === '1' });
    this.store = new Store(path.join(config.dataDir, 'hermes'));
    const ctx: Ctx = { store: this.store, emit: (m) => this.emit(m), now: () => Date.now(), log: this.log };
    this.repos = new RepoManager(ctx, path.join(config.dataDir, 'worktrees'), { mergeStyle: 'merge' });
    this.cast = loadCast(path.join(config.projectRoot, 'hermes-studio')).cast;
    this.seedAgents();
    this.engine = new HermesEngine(this as any, {
      yolo: config.yolo,
      leadModel: config.leadModel,
      workerModel: config.workerModel,
      effort: config.effort,
      leadEffort: config.leadEffort,
    });
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.server = new ProtocolServer(this, this.config.port);
    this.repos.startPolling(15_000);
    const auth = await this.engine.checkAuth();
    if (auth.ok) {
      this.auth = 'ok';
      this.account = auth.account;
      this.backendMessage = `${this.engine.label} ready`;
      this.log.info(`backend ${this.engine.label} ready (${auth.account})`);
    } else {
      this.auth = 'failed';
      this.backendMessage = auth.message;
      this.log.error(`backend check failed: ${auth.message}`);
      this.notify('need_user', auth.message);
    }
    this.broadcastStatus();
    this.log.info(`studio listening on ws://127.0.0.1:${this.config.port} (protocol v1)`);
    // a restart mid-goal must not strand work: pick the board up where it was
    this.assignOpenTasks();
  }

  stop(): void {
    this.repos.stopPolling();
    this.store.flush();
    this.store.close();
    for (const c of this.aborters.values()) c.abort();
    this.aborters.clear();
    this.server?.close();
  }

  // ── protocol plumbing ────────────────────────────────────────────────────────────────────────

  emit(msg: Outbound): void {
    this.server?.broadcast(msg);
  }

  private nextId(prefix: string): string {
    return `msg-${++this.msgN}-${prefix}`;
  }

  private broadcastStatus(): void {
    this.emit({
      v: 1,
      id: this.nextId('status'),
      type: 'foreman.status',
      foreman: {
        version: STUDIO_VERSION,
        backend: 'hermes',
        auth: this.auth,
        message: this.backendMessage,
        account: this.account,
        userName: this.config.userName,
      },
    } as any);
  }

  notify(level: 'info' | 'warn' | 'need_user', text: string, decisionId?: string): void {
    this.emit({ v: 1, id: this.nextId('notify'), type: 'notify', level, text, decisionId, ts: Date.now() } as any);
  }

  /** The full state the mod renders after `hello`. */
  snapshot(): Outbound {
    const open = this.store.data.decisions.filter((d) => d.status === 'open');
    const answered = this.store.data.decisions.filter((d) => d.status !== 'open').slice(-20);
    return {
      v: 1,
      id: this.nextId('snap'),
      type: 'snapshot',
      foreman: {
        version: STUDIO_VERSION,
        backend: 'hermes',
        auth: this.auth,
        message: this.backendMessage,
        account: this.account,
        userName: this.config.userName,
      },
      agents: this.store.data.agents,
      tasks: this.store.data.tasks,
      decisions: [...answered, ...open],
      repos: this.repos.list(),
      memory: this.memory(),
      goal: this.store.data.goals.at(-1),
      goals: this.store.data.goals,
      feed: this.store.data.feed.slice(-200),
      logs: this.store.data.agents.map((a) => ({ agentId: a.id, entries: this.store.logTail(a.id) })),
    } as any;
  }

  // ── state helpers ────────────────────────────────────────────────────────────────────────────

  agent(id: string): Agent | undefined {
    return this.store.data.agents.find((a) => a.id === id);
  }

  setAgent(id: string, patch: Partial<Agent>): void {
    const a = this.agent(id);
    if (!a) return;
    Object.assign(a, patch);
    this.emit({ v: 1, id: this.nextId('agent'), type: 'agent.upsert', agent: a } as any);
  }

  agentLog(id: string, kind: 'text' | 'tool' | 'result' | 'error' | 'diff', text: string): void {
    const entries = [{ ts: Date.now(), kind, text }];
    this.store.appendLog(id, entries);
    this.emit({ v: 1, id: this.nextId('log'), type: 'agent.log', agentId: id, entries } as any);
  }

  feed(kind: FeedKind, text: string, agentId?: string, to?: string): void {
    const item = { ts: Date.now(), kind, text, agentId, to };
    this.store.pushFeed(item);
    this.emit({ v: 1, id: this.nextId('feed'), type: 'feed.add', item } as any);
  }

  say(agentId: string, text: string, to?: string): void {
    this.emit({ v: 1, id: this.nextId('say'), type: 'agent.say', agentId, text, to, ts: Date.now() } as any);
    if (to && to !== agentId) this.feed('message', `${agentId} → ${to}: ${text}`, agentId, to);
  }

  upsertTask(task: Task): void {
    this.store.markDirty();
    this.emit({ v: 1, id: this.nextId('task'), type: 'task.upsert', task } as any);
  }

  upsertDecision(d: Decision): void {
    this.store.markDirty();
    this.emit({ v: 1, id: this.nextId('decision'), type: 'decision.upsert', decision: d } as any);
  }

  upsertGoal(goal: Goal): void {
    this.store.markDirty();
    this.emit({ v: 1, id: this.nextId('goal'), type: 'goal.upsert', goal } as any);
  }

  private memory(): MemoryEntry[] {
    const backend = this.store.data.backend as { memory?: MemoryEntry[] };
    if (!Array.isArray(backend.memory)) backend.memory = [];
    return backend.memory;
  }

  private saveMemory(entry: MemoryEntry): void {
    const list = this.memory();
    const idx = list.findIndex((m) => m.id === entry.id);
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);
    this.store.markDirty();
    this.emit({ v: 1, id: this.nextId('memory'), type: 'memory.upsert', entry } as any);
  }

  /** Memory API used by the team tools (files under <dataDir>/memory/<scope>/). */
  memoryDir(scope: string): string {
    return path.join(this.config.dataDir, 'memory', scope);
  }

  writeMemory(input: { scope: string; title: string; body: string; author: string }): MemoryEntry {
    const dir = this.memoryDir(input.scope);
    fs.mkdirSync(dir, { recursive: true });
    const id = `${input.scope}/${slug(input.title)}`;
    const entry: MemoryEntry = {
      id,
      scope: input.scope,
      title: input.title,
      body: input.body,
      updated: Date.now(),
      author: input.author,
    };
    fs.writeFileSync(path.join(dir, `${slug(input.title)}.md`), `# ${input.title}\n\n${input.body}\n`, 'utf8');
    this.saveMemory(entry);
    return entry;
  }

  readMemory(scope: string, title?: string): { titles: string[]; body?: string } {
    const dir = this.memoryDir(scope);
    if (!fs.existsSync(dir)) return { titles: [] };
    const titles = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''));
    if (!title) return { titles };
    const file = path.join(dir, `${slug(title)}.md`);
    if (!fs.existsSync(file)) return { titles };
    return { titles, body: fs.readFileSync(file, 'utf8') };
  }

  // ── the team ─────────────────────────────────────────────────────────────────────────────────

  private seedAgents(): void {
    const prev = new Map(this.store.data.agents.map((a) => [a.id, a]));
    const seeded: Agent[] = this.cast.map((m) => {
      const old = prev.get(m.id);
      return {
        id: m.id,
        name: m.name,
        role: m.role,
        title: m.title,
        color: m.color,
        accent: m.accent,
        skin: m.id,
        state: 'idle',
        activity: old?.activity ?? 'off shift',
        station: 'lounge',
        taskId: old?.taskId,
        repoId: old?.repoId,
        worktree: old?.worktree,
        paused: false,
        active: m.role === 'lead' ? true : this.config.workers.has(m.id),
        engine: 'hermes',
        model: old?.model,
      };
    });
    this.store.data.agents = seeded;
    this.store.markDirty();
  }

  activeWorkers(): Agent[] {
    return this.store.data.agents.filter((a) => a.role === 'worker' && a.active);
  }

  private currentGoal(): Goal | undefined {
    return this.store.data.goals.at(-1);
  }

  /** The goal tasks are being created for (the latest one). */
  currentGoalId(): string | undefined {
    return this.currentGoal()?.id;
  }

  private currentRepoId(): string | undefined {
    const goal = this.currentGoal();
    if (goal?.repoId) return goal.repoId;
    return this.repos.defaultRepo()?.id;
  }

  // ── goals and the brain ──────────────────────────────────────────────────────────────────────

  async addRepo(p: string): Promise<string> {
    const repo = await this.repos.add(p);
    this.feed('system', `repo ${repo.id} registered (${repo.path}, base ${repo.branch})`);
    return repo.id;
  }

  async submitGoal(text: string, repoId?: string): Promise<Goal> {
    const id = this.store.nextId('g');
    const goal: Goal = {
      id,
      text,
      progress: 0,
      status: 'planning',
      repoId: repoId ?? this.currentRepoId(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.store.data.goals.push(goal);
    this.upsertGoal(goal);
    this.feed('goal', `goal ${id}: ${text}`, 'user');
    this.notify('info', `New goal: ${text}`);
    const repo = goal.repoId ? this.repos.get(goal.repoId) : undefined;
    void this.enqueue(LEAD_ID, () =>
      this.runTurn(LEAD_ID, 'lead', this.goalPrompt(goal, repo?.path, repo?.branch), {
        cwd: repo?.path,
        activity: `planning ${id}`,
      }),
    );
    return goal;
  }

  private goalPrompt(goal: Goal, repoPath?: string, branch?: string): string {
    return [
      `${this.config.userName} gave you a new goal (${goal.id}):`,
      '',
      goal.text,
      '',
      repoPath ? `It lands in the repo at ${repoPath} (base branch ${branch ?? 'main'}). You are read-only there — you plan, workers implement.` : '',
      'Do this:',
      '1. Write your plan to shared memory (mcp_agentcraft_write_memory, scope "shared") so the team and the user can see it.',
      '2. Split it into tasks with mcp_agentcraft_create_task — small enough that one worker finishes each in a few steps, with a clear description. Assign them if you know who fits.',
      '3. Tell the user the plan in one short mcp_agentcraft_say (to "user").',
      `4. If anything about the goal is genuinely ambiguous, ask with mcp_agentcraft_ask_user before creating tasks.`,
    ]
      .filter((l) => l !== '')
      .join('\n');
  }

  /** Every task of the current goal moves the goal; when they are all done, so is the goal. */
  private afterTasksChanged(): void {
    const goal = this.currentGoal();
    if (!goal) return;
    const tasks = this.store.data.tasks.filter((t) => t.goalId === goal.id);
    const live = tasks.filter((t) => t.status !== 'cancelled');
    const done = live.filter((t) => t.status === 'done');
    goal.progress = live.length ? done.length / live.length : 0;
    if (live.length && done.length === live.length) {
      if (goal.status !== 'done') {
        goal.status = 'done';
        this.feed('goal', `goal ${goal.id} done: ${goal.text}`, 'user');
        this.say(LEAD_ID, `Goal ${goal.id} is done: ${goal.text}`, 'user');
      }
    } else if (goal.status !== 'cancelled') {
      goal.status = tasks.length ? 'active' : 'planning';
    }
    this.upsertGoal(goal);
    this.assignOpenTasks();
  }

  /**
   * Every `todo` task gets a worker: its assignee if that agent is on shift and free, otherwise
   * the next free on-shift worker (a task assigned to an off-shift agent is moved, not stranded).
   */
  assignOpenTasks(): void {
    const busy = new Set(
      this.store.data.tasks
        .filter((t) => t.assignee && (t.status === 'doing' || t.status === 'review'))
        .map((t) => t.assignee as string),
    );
    for (const task of this.store.data.tasks) {
      if (task.status !== 'todo') continue;
      const assignee = task.assignee;
      if (assignee && !busy.has(assignee) && this.agent(assignee)?.active === true) {
        this.startWorker(assignee, task.id);
        busy.add(assignee);
        continue;
      }
      const free = this.activeWorkers().filter((w) => !busy.has(w.id));
      const pick = free[0];
      if (!pick) {
        this.feed('task', `${task.id} is waiting for a free worker`);
        continue;
      }
      if (assignee && assignee !== pick.id) {
        this.feed('task', `${task.id} moved from ${assignee} (off shift or busy) to ${pick.id}`, pick.id);
      }
      task.assignee = pick.id;
      task.repoId = task.repoId ?? this.currentRepoId();
      task.updatedAt = Date.now();
      this.upsertTask(task);
      this.feed('task', `${pick.id} picks up ${task.id}`, pick.id);
      busy.add(pick.id);
      this.startWorker(pick.id, task.id);
    }
  }

  /** Tasks that were waiting on a merge when the studio stopped get another chance. */
  recoverReviews(): void {
    for (const task of this.store.data.tasks) {
      if (task.status !== 'review' || !task.repoId || !task.worktree) continue;
      this.feed('task', `${task.id} was in review when the studio stopped — re-requesting the merge`, task.assignee);
      void this.requestMerge(task.id, task.assignee ?? 'user');
    }
  }



  /** A goal still waiting for a plan (its lead turn died, e.g. the provider was down) gets another go. */
  recoverPlanning(): void {
    const goal = this.currentGoal();
    if (!goal || goal.status !== 'planning') return;
    if (this.store.data.tasks.some((t) => t.goalId === goal.id)) return;
    const repo = goal.repoId ? this.repos.get(goal.repoId) : undefined;
    this.feed('system', `goal ${goal.id} has no plan yet — asking the lead again`, LEAD_ID);
    void this.enqueue(LEAD_ID, () =>
      this.runTurn(LEAD_ID, 'lead', this.goalPrompt(goal, repo?.path, repo?.branch), {
        cwd: repo?.path,
        activity: `planning ${goal.id}`,
      }),
    );
  }

  private startWorker(agentId: string, taskId: string): void {
    const key = `${agentId}:${taskId}`;
    if (this.queues.has(key)) return;
    void this.enqueue(key, () => this.workerTurn(agentId, taskId));
  }

  private async workerTurn(agentId: string, taskId: string): Promise<void> {
    const task = this.store.data.tasks.find((t) => t.id === taskId);
    if (!task) return;
    if (!task.repoId) {
      task.status = 'blocked';
      task.blockedReason = 'no repo on this task';
      this.upsertTask(task);
      return;
    }
    try {
      const repo = this.repos.require(task.repoId);
      let wt = task.worktree ? this.repos.findWorktree(task.repoId, task.worktree) : undefined;
      if (!wt) {
        wt = await this.repos.createWorktree(
          task.repoId,
          agentId,
          { id: task.id, title: task.title },
          { startPoint: task.startBranch ?? repo.branch },
        );
      }
      task.worktree = wt.id;
      task.branch = wt.branch;
      task.status = 'doing';
      task.assignee = agentId;
      task.updatedAt = Date.now();
      this.upsertTask(task);
      this.setAgent(agentId, { taskId: task.id, repoId: task.repoId, worktree: wt.id });
      this.feed('task', `${agentId} starts ${task.id} in ${wt.id} (${wt.branch})`, agentId);
      await this.runTurn(
        agentId,
        'worker',
        [
          `Your task is ${task.id}: ${task.title}`,
          '',
          task.description ?? '(no description)',
          '',
          `Work in ${wt.path} on branch ${wt.branch} (base ${repo.branch}).`,
          'When the work is done: commit it in your worktree, then call mcp_agentcraft_update_task with status "review" — CI runs and the merge is requested for you.',
          'If you get stuck, say so with mcp_agentcraft_update_task (status "blocked", summary = why).',
        ].join('\n'),
        { taskId: task.id, cwd: wt.path, activity: `working on ${task.id}` },
      );
      if (task.status === 'doing') {
        this.feed('task', `${task.id} is still "doing" after ${agentId}'s turn`, agentId);
      }
    } catch (e) {
      this.log.error(`worker turn ${agentId}/${taskId} failed: ${(e as Error).message}`);
      task.status = 'blocked';
      task.blockedReason = (e as Error).message;
      task.updatedAt = Date.now();
      this.upsertTask(task);
      this.setAgent(agentId, { state: 'error', activity: 'turn failed' });
      this.agentLog(agentId, 'error', (e as Error).message);
    }
  }

  // ── one agent turn ───────────────────────────────────────────────────────────────────────────

  private async runTurn(
    agentId: string,
    role: Role,
    prompt: string,
    opts: { taskId?: string; cwd?: string; activity?: string } = {},
  ): Promise<TurnStats> {
    const member = this.cast.find((m) => m.id === agentId);
    if (!member) return { isError: true, errors: [`no cast member ${agentId}`] };
    const task = opts.taskId ? this.store.data.tasks.find((t) => t.id === opts.taskId) : undefined;
    const cwd =
      opts.cwd ??
      (task?.worktree && task.repoId
        ? this.repos.requireWorktree(task.repoId, task.worktree).path
        : this.repos.defaultRepo()?.path ?? process.cwd());

    const abort = new AbortController();
    const turn = new SimpleTurn();
    this.aborters.set(agentId, abort);
    this.turns.set(agentId, turn);

    const hooks: ToolHooks = {
      onReview: (a, t) => void this.reviewTask(a, t),
      onChangesRequested: (t, fb) => void this.changesRequested(t, fb),
      onTasksChanged: () => this.afterTasksChanged(),
      onMergeRequested: (t) => this.log.info(`merge requested for ${t}`),
      onWaiting: (a, waiting) =>
        this.setAgent(a, {
          state: waiting ? 'waiting_user' : 'thinking',
          activity: waiting ? 'waiting for the user' : 'working',
          station: waiting ? 'user' : 'terminal',
        }),
    };

    let model: string | undefined;
    // A resumed session keeps the model it was launched with: Hermes refuses `--model` on resume
    // ("creation overrides are unsupported on resume"). So when this turn's model differs from the
    // one the stored session recorded, start a fresh session instead of failing every turn.
    const wanted = role === 'lead' ? this.config.leadModel : this.config.workerModel;
    const prev = this.store.data.sessions[agentId];
    const resumable = !wanted || !prev?.model || prev.model === wanted;
    if (!resumable && prev?.sessionId) {
      this.agentLog(agentId, 'text', `model changed to ${wanted} — starting a fresh session`);
      delete prev.sessionId;
      this.store.markDirty();
    }
    const spec: TurnSpec = {
      agentId,
      role,
      cwd,
      prompt,
      instructions: this.instructions(role, member, cwd, task),
      resume: resumable ? this.store.data.sessions[agentId]?.sessionId : undefined,
      env: withGitSafety(process.env, agentGitIdentity(agentId) as Record<string, string>),
      abort,
      turn,
      permission: this.gate(agentId, role, cwd),
      tools: agentTools(this as any, agentId, role, hooks, turn),
      onProcess: (child: ChildProcess) => this.attachChild(agentId, child, abort),
      onSession: (sid) => this.saveSession(agentId, sid),
      onModel: (m) => {
        model = m;
        this.setAgent(agentId, { model: m });
      },
    };

    const started = Date.now();
    this.setAgent(agentId, {
      state: 'thinking',
      activity: opts.activity ?? 'thinking',
      station: role === 'lead' ? 'meeting' : 'terminal',
      paused: false,
    });
    this.agentLog(agentId, 'text', prompt);

    let stats: TurnStats;
    // Two ways a turn can end having done nothing, both of which look like success on the wire:
    //   • the model spends its output budget mid-turn and is cut off (the free model does this);
    //   • the provider fails the request and the gateway reports it as a short text response.
    // Either way the goal would stall forever, so resume the same session — bounded, so a
    // genuinely stuck turn still ends and reports. Nothing was changed by a failed turn, so a
    // transport failure replays the original prompt while a cut-off gets a continue nudge.
    const MAX_RETRIES = 2;
    for (let attempt = 0; ; attempt++) {
      try {
        stats = await this.engine.runTurn(spec);
      } catch (e) {
        this.aborters.delete(agentId);
        this.setAgent(agentId, { state: 'error', activity: 'turn failed' });
        this.agentLog(agentId, 'error', `turn failed: ${(e as Error).message}`);
        this.log.error(`${agentId} turn failed: ${(e as Error).message}`);
        return { isError: true, errors: [(e as Error).message] };
      }
      const resultText = stats.resultText ?? '';
      const haystack = [resultText, ...(stats.errors ?? [])].join(' ');
      const cutOff = /cut off|output length limit/i.test(haystack);
      // A failed request reaches the studio as a canned sentence, not an exception: Hermes answers
      // "Your request was not processed..." (or echoes the provider's message) with exit 0, and the
      // provider's own hiccups (403/408/429, a dead upstream) surface as "not retryable" inside the
      // CLI but are worth another attempt from here.
      const transportFailure =
        stats.numTurns === 0 &&
        /transient agent failure|api call failed|connection reset|non-retryable|error code|model is unavailable|failed to deserialize|not processed|not allowed to use model|permission_error|permissiondenied|rate limit/i.test(
          haystack,
        );
      // Either one is worth resuming the session for — including when the CLI already called it a
      // hard error (a 403 that flaps is the common case, not a reason to strand the goal).
      const retryable = cutOff || transportFailure;
      if (!retryable || attempt >= MAX_RETRIES) {
        if (transportFailure && attempt >= MAX_RETRIES) stats.isError = true;
        break;
      }
      this.agentLog(
        agentId,
        'text',
        cutOff ? 'the reply was cut off at the output limit — continuing' : 'the turn failed at the provider — retrying',
      );
      this.feed('system', `${agentId}: ${cutOff ? 'output limit hit' : 'provider failed'} — retrying automatically`, agentId);
      // a moment for a flapping provider (403/408/429) to come back before the retry
      await new Promise((r) => setTimeout(r, 2000));
      spec.resume = this.store.data.sessions[agentId]?.sessionId;
      spec.prompt = cutOff
        ? 'Continue exactly where you stopped. Take the smallest possible step: one tool call, then stop and report what you did.'
        : prompt;
    }
    this.aborters.delete(agentId);
    this.turns.delete(agentId);

    const rec = this.store.data.sessions[agentId] ?? { turns: 0, costUsd: 0, updatedAt: 0 };
    rec.turns += 1;
    rec.updatedAt = Date.now();
    rec.engine = 'hermes';
    if (stats.sessionId) rec.sessionId = stats.sessionId;
    if (model) rec.model = model;
    this.store.data.sessions[agentId] = rec;
    this.store.markDirty();

    if (stats.isError) {
      this.setAgent(agentId, { state: 'error', activity: 'error' });
      this.agentLog(agentId, 'error', stats.resultText || 'turn ended with an error');
    } else {
      this.setAgent(agentId, { state: 'idle', activity: task ? `${task.id} idle` : 'idle', station: 'lounge' });
      if (stats.resultText) this.agentLog(agentId, 'result', stats.resultText.slice(0, 4000));
    }
    this.log.info(
      `${agentId} turn done in ${((Date.now() - started) / 1000).toFixed(1)}s (${stats.numTurns ?? '?'} steps${
        stats.tokens ? `, ${stats.tokens} tok` : ''
      })`,
    );
    return stats;
  }

  private instructions(role: Role, member: CastMember, cwd: string, task?: Task): string {
    const others = this.cast.filter((m) => m.id !== member.id);
    return [
      `You are ${member.name}, ${member.title || member.role} in the AgentCraft studio.`,
      `The user is ${this.config.userName}. They watch you in the Minecraft world and answer what you send with mcp_agentcraft_ask_user.`,
      `Your working directory is ${cwd}.${
        role === 'lead'
          ? " It is the user's checkout and it is READ-ONLY for you: never edit files or run commands that change anything."
          : ' It is your own git worktree: commit your work there (your own AgentCraft identity, no push).'
      }`,
      task ? `Your task ${task.id}: ${task.title}\n${task.description ?? ''}` : '',
      `The team: ${others.map((m) => `${m.name} (${m.id})`).join(', ')}. Message them with mcp_agentcraft_send_message.`,
      'Shared memory is how you keep plans between turns: mcp_agentcraft_write_memory / mcp_agentcraft_read_memory.',
      role === 'lead'
        ? 'You are the lead: plan the goal, split it into tasks with mcp_agentcraft_create_task, review results, and ask the user whenever a choice is theirs. Do not write code yourself.'
        : 'Do your task, run the tests, then mcp_agentcraft_update_task to review. Do not touch tasks that are not yours.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** The tool gate: the same policy engine the Foreman used, in front of Hermes tools. */
  private gate(agentId: string, role: Role, cwd: string): PermissionGate {
    return async (toolName, input) => {
      const canonical = TOOL_ALIASES[toolName] ?? toolName;
      const ctx: PolicyContext = {
        role,
        cwd,
        readDirs: [this.config.dataDir, this.config.projectRoot],
        alwaysAllow: this.store.data.permissionRules[agentId] ?? [],
        mcpServer: 'agentcraft',
        tempDirs: [os.tmpdir()],
      };
      const verdict = classifyToolUse(canonical, input, ctx);
      if (verdict.action === 'allow') return { allow: true };
      return {
        allow: false,
        message:
          verdict.action === 'ask'
            ? `${verdict.reason} — if you really need it, ask the user with mcp_agentcraft_ask_user.`
            : verdict.reason,
      };
    };
  }

  private attachChild(agentId: string, child: ChildProcess, abort: AbortController): void {
    const kill = () => {
      try {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 3000).unref();
      } catch {
        /* already gone */
      }
    };
    abort.signal.addEventListener('abort', kill, { once: true });
    child.on('exit', () => abort.signal.removeEventListener('abort', kill));
  }

  private saveSession(agentId: string, sessionId: string): void {
    const rec = this.store.data.sessions[agentId] ?? { turns: 0, costUsd: 0, updatedAt: 0 };
    rec.sessionId = sessionId;
    rec.engine = 'hermes';
    rec.updatedAt = Date.now();
    this.store.data.sessions[agentId] = rec;
    this.store.markDirty();
    this.log.debug(`${agentId} session ${sessionId}`);
  }

  /** One turn at a time per agent (key), in arrival order. */
  private enqueue(key: string, fn: () => Promise<unknown>): Promise<unknown> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev
      .then(fn)
      .catch((e) => this.log.error(`${key}: ${e instanceof Error ? e.message : String(e)}`));
    this.queues.set(key, next);
    void next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
    return next;
  }

  // ── review, CI and merges ────────────────────────────────────────────────────────────────────

  private async reviewTask(agentId: string, taskId: string): Promise<void> {
    const task = this.store.data.tasks.find((t) => t.id === taskId);
    if (!task?.repoId || !task.worktree) return;
    this.setAgent(agentId, { state: 'testing', activity: `CI ${task.id}`, station: 'testbench' });
    let ci;
    try {
      ci = await this.repos.runTests(task.repoId, task.worktree);
    } catch (e) {
      this.agentLog(agentId, 'error', `CI could not run: ${(e as Error).message}`);
      return;
    }
    task.ci = ci.pass ? 'pass' : 'fail';
    task.updatedAt = Date.now();
    this.upsertTask(task);
    this.feed('ci', `CI ${task.ci} for ${task.id}: ${ci.command} (${(ci.durationMs / 1000).toFixed(1)}s)`, agentId);
    const res = await this.requestMerge(taskId, agentId);
    if (!res.merged) this.agentLog(agentId, 'text', `merge not done: ${res.reason}`);
  }

  async requestMerge(
    taskId: string,
    by = 'user',
  ): Promise<{ merged: boolean; reason: string; decisionId?: string; sha?: string; branch?: string }> {
    const task = this.store.data.tasks.find((t) => t.id === taskId);
    if (!task) return { merged: false, reason: `no task ${taskId}` };
    if (!task.repoId || !task.worktree) return { merged: false, reason: `${taskId} has no worktree yet` };
    const repo = this.repos.require(task.repoId);

    let ci;
    try {
      ci = await this.repos.runTests(task.repoId, task.worktree);
    } catch (e) {
      return { merged: false, reason: `CI could not run: ${(e as Error).message}` };
    }
    task.ci = ci.pass ? 'pass' : 'fail';
    task.updatedAt = Date.now();
    this.upsertTask(task);
    this.feed('ci', `CI ${task.ci} for ${task.id}: ${ci.command}`, by);
    if (!ci.pass) {
      const why = ci.failures?.length ? ci.failures.slice(0, 3).join('; ') : ci.command;
      return { merged: false, reason: `CI failed (${why})` };
    }
    const can = await this.repos.canMerge(task.repoId, task.worktree);
    if (!can.ok) return { merged: false, reason: `cannot merge: ${can.reason}` };

    const auto = this.config.autoMerge.has('all') || this.config.autoMerge.has(task.repoId);
    if (auto) {
      this.log.info(`${task.id}: CI green in experiment repo ${repo.id} — merging without asking`);
      return this.doMerge(task, by);
    }

    const decision: Decision = {
      id: this.store.nextId('d'),
      agentId: by,
      kind: 'merge',
      question: `Merge ${task.id} (${task.title}) into ${repo.branch}?`,
      options: [...MERGE_OPTIONS],
      status: 'open',
      createdAt: Date.now(),
      taskId: task.id,
      repoId: task.repoId,
      worktree: task.worktree,
      context: [task.summary, `${ci.command} passed`, `${task.branch} → ${repo.branch}`].filter(Boolean).join('\n'),
    };
    this.store.data.decisions.push(decision);
    this.upsertDecision(decision);
    this.feed('decision', `${by} asks to merge ${task.id} into ${repo.branch}`, by);
    this.say(LEAD_ID, `May I merge ${task.id} into ${repo.branch}?`, 'user');
    this.notify('need_user', `${task.id} is ready to merge into ${repo.branch}`, decision.id);
    return { merged: false, decisionId: decision.id, reason: 'waiting for the user' };
  }

  private async doMerge(task: Task, by: string): Promise<{ merged: boolean; reason: string; sha?: string; branch?: string }> {
    // The merge layer refuses any decision that does not carry an explicit "Merge" answer — so the
    // auto-merge path must present one. It is honest: the user put this repo on --auto-merge, and
    // CI is green; the answer below records that approval (who asked, when).
    const decision: Decision = {
      id: this.store.nextId('d'),
      agentId: by,
      kind: 'merge',
      question: `merge ${task.id}`,
      options: [...MERGE_OPTIONS],
      status: 'answered',
      answer: { option: 'Merge', text: `auto-merge: CI green in an experiment repo`, ts: Date.now() },
      createdAt: Date.now(),
      taskId: task.id,
      repoId: task.repoId,
      worktree: task.worktree,
    };
    try {
      const res = await this.repos.merge(decision, { commitMessage: `${task.id}: ${task.title}` });
      task.status = 'done';
      task.ci = 'pass';
      task.updatedAt = Date.now();
      task.summary = task.summary ?? `merged ${res.sha.slice(0, 7)} into ${res.base}`;
      this.upsertTask(task);
      this.feed('merge', `${task.id} merged into ${res.base} (${res.sha.slice(0, 7)}, ${res.files} files)`, by);
      this.say(LEAD_ID, `${task.id} is in ${res.base}.`, 'user');
      this.afterTasksChanged();
      return { merged: true, reason: `merged into ${res.base}`, sha: res.sha, branch: res.base };
    } catch (e) {
      this.agentLog(LEAD_ID, 'error', `merge of ${task.id} failed: ${(e as Error).message}`);
      return { merged: false, reason: `merge failed: ${(e as Error).message}` };
    }
  }

  private async changesRequested(taskId: string, feedback: string): Promise<void> {
    const task = this.store.data.tasks.find((t) => t.id === taskId);
    if (!task) return;
    task.status = 'doing';
    task.updatedAt = Date.now();
    task.summary = `changes requested: ${feedback}`;
    this.upsertTask(task);
    this.feed('task', `${task.id} back to doing: ${feedback}`, task.assignee);
    if (task.assignee && task.worktree && task.repoId) {
      const wt = this.repos.findWorktree(task.repoId, task.worktree);
      if (wt) {
        void this.enqueue(`${task.assignee}:${task.id}:changes`, () =>
          this.runTurn(
            task.assignee as string,
            'worker',
            [
              `${this.config.userName} reviewed ${task.id} and wants changes:`,
              '',
              feedback,
              '',
              `Keep working in ${wt.path} on ${wt.branch}. When done, mcp_agentcraft_update_task to review again.`,
            ].join('\n'),
            { taskId: task.id, cwd: wt.path, activity: `fixing ${task.id}` },
          ),
        );
      }
    }
  }

  async answerDecision(
    decisionId: string,
    answer: { option?: string | number; text?: string },
  ): Promise<{ ok: boolean; error?: string }> {
    const d = this.store.data.decisions.find((x) => x.id === decisionId);
    if (!d) return { ok: false, error: `no decision ${decisionId}` };
    if (d.status !== 'open') return { ok: false, error: `${decisionId} is already ${d.status}` };
    const option =
      typeof answer.option === 'number' ? (d.options[answer.option] ?? String(answer.option)) : (answer.option ?? d.options[0]);
    d.answer = { option, text: answer.text, ts: Date.now() };
    d.status = 'answered';
    this.upsertDecision(d);
    this.feed('decision', `${this.config.userName} answered ${d.id}: ${option}`, 'user');
    this.decisionWaiters.get(d.id)?.(answer.text ?? option);
    this.decisionWaiters.delete(d.id);

    if (d.kind === 'merge' && d.taskId) {
      const task = this.store.data.tasks.find((t) => t.id === d.taskId);
      if (option === 'Merge' && task) await this.doMerge(task, 'user');
      else if (option === 'Request changes' && task) await this.changesRequested(task.id, answer.text ?? 'the user wants changes');
      else if (option === 'Reject' && task) {
        if (task.repoId && task.worktree) await this.repos.abandon(task.repoId, task.worktree, 'rejected by the user');
        task.status = 'cancelled';
        task.updatedAt = Date.now();
        this.upsertTask(task);
        this.afterTasksChanged();
      }
    }
    return { ok: true };
  }

  /** Block a turn until the user answers a decision (or the turn ends). */
  waitForDecision(id: string, turn?: TurnHandle): Promise<string | undefined> {
    return new Promise((resolve) => {
      const started = Date.now();
      const finish = (value: string | undefined) => {
        clearInterval(timer);
        this.decisionWaiters.delete(id);
        resolve(value);
      };
      const timer = setInterval(() => {
        const d = this.store.data.decisions.find((x) => x.id === id);
        if (d && d.status !== 'open') return finish(d.answer?.text ?? d.answer?.option);
        if (turn?.reason()) return finish(undefined);
        if (Date.now() - started > 6 * 3600_000) return finish(undefined);
      }, 500);
      this.decisionWaiters.set(id, finish);
    });
  }

  // ── client messages ──────────────────────────────────────────────────────────────────────────

  async handleClient(msg: any): Promise<{ ok: boolean; error?: string; result?: Record<string, unknown> }> {
    try {
      switch (msg?.type) {
        case 'hello':
          return { ok: true };
        case 'goal.submit': {
          const goal = await this.submitGoal(String(msg.text), msg.repoId);
          return { ok: true, result: { goalId: goal.id } };
        }
        case 'user.message':
          return this.userMessage(String(msg.to), String(msg.text));
        case 'decision.answer':
          return await this.answerDecision(String(msg.decisionId), { option: msg.option, text: msg.text });
        case 'repo.add':
          return { ok: true, result: { repoId: await this.addRepo(String(msg.path)) } };
        case 'diff.request':
          return await this.diffRequest(msg);
        case 'task.action':
          return await this.taskAction(msg);
        case 'agent.action':
          return await this.agentAction(msg);
        default:
          return { ok: false, error: `unknown message ${String(msg?.type)}` };
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** A message from the user through the world (console `@name text`, or the Decision Podium). */
  userMessage(to: string, text: string): { ok: boolean; error?: string; result?: Record<string, unknown> } {
    let target = to;
    if (to === 'all' || to === 'user') {
      const m = /^@([a-z0-9_-]+)\s+/i.exec(text);
      const named = m?.[1];
      target = named && this.agent(named) ? named : LEAD_ID;
    }
    const agent = this.agent(target);
    if (!agent) return { ok: false, error: `no agent named "${to}"` };
    this.feed('user', `${this.config.userName} → ${target}: ${text}`, 'user', target);
    if (!agent.active) {
      agent.active = true;
      this.setAgent(target, { active: true });
    }
    void this.enqueue(`${target}:user`, () =>
      this.runTurn(
        target,
        agent.role,
        [
          `${this.config.userName} says${to === 'all' ? ' to everyone' : ` to you`}: "${text}"`,
          '',
          `Answer them with mcp_agentcraft_say (to "user") so they see it in the world, then carry on with what you were doing.`,
        ].join('\n'),
        { activity: 'answering the user' },
      ),
    );
    return { ok: true, result: { agentId: target } };
  }

  private async diffRequest(msg: any): Promise<{ ok: boolean; error?: string; result?: Record<string, unknown> }> {
    const wanted = String(msg.worktree);
    // a worktree id or an agent id resolves against every repo we know
    let repo = this.repos.defaultRepo();
    let wt = repo ? this.repos.findWorktree(repo.id, wanted) : undefined;
    for (const r of this.repos.list()) {
      const found = this.repos.findWorktree(r.id, wanted);
      if (found) {
        repo = r;
        wt = found;
        break;
      }
    }
    if (!repo || !wt) return { ok: false, error: `no worktree ${wanted}` };
    try {
      const d = await this.repos.diff(repo.id, wt.id);
      this.emit({
        v: 1,
        id: this.nextId('diff'),
        type: 'diff',
        requestId: String(msg.requestId),
        repoId: repo.id,
        worktree: wt.id,
        base: wt.base,
        branch: wt.branch,
        files: d.files,
        stats: d.stats,
        truncated: d.truncated,
      } as any);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async taskAction(msg: any): Promise<{ ok: boolean; error?: string }> {
    const task = this.store.data.tasks.find((t) => t.id === String(msg.taskId));
    if (!task) return { ok: false, error: `no task ${String(msg.taskId)}` };
    switch (msg.action) {
      case 'reassign': {
        const to = String(msg.arg ?? '');
        if (!this.agent(to)) return { ok: false, error: `no agent ${to}` };
        task.assignee = to;
        task.updatedAt = Date.now();
        this.upsertTask(task);
        this.startWorker(to, task.id);
        return { ok: true };
      }
      case 'cancel': {
        task.status = 'cancelled';
        task.updatedAt = Date.now();
        this.upsertTask(task);
        if (task.repoId && task.worktree) await this.repos.abandon(task.repoId, task.worktree, 'cancelled by the user');
        this.afterTasksChanged();
        return { ok: true };
      }
      case 'retry': {
        task.status = 'todo';
        task.assignee = undefined;
        task.updatedAt = Date.now();
        this.upsertTask(task);
        this.afterTasksChanged();
        return { ok: true };
      }
      case 'prioritize': {
        task.priority = Number(msg.arg ?? (Math.max(0, ...this.store.data.tasks.map((t) => t.priority)) + 1));
        this.upsertTask(task);
        return { ok: true };
      }
      default:
        return { ok: false, error: `unknown task action ${String(msg.action)}` };
    }
  }

  private async agentAction(msg: any): Promise<{ ok: boolean; error?: string }> {
    const id = String(msg.agentId);
    const agent = this.agent(id);
    if (!agent) return { ok: false, error: `no agent ${id}` };
    switch (msg.action) {
      case 'pause': {
        const turn = this.turns.get(id);
        if (turn) turn.reasonText = 'paused by the user';
        const abort = this.aborters.get(id);
        if (abort) abort.abort();
        agent.paused = true;
        this.setAgent(id, { paused: true, state: 'idle', activity: 'paused' });
        return { ok: true };
      }
      case 'resume':
        agent.paused = false;
        this.setAgent(id, { paused: false, state: 'idle', activity: 'idle' });
        return { ok: true };
      case 'stop': {
        const turn = this.turns.get(id);
        if (turn) turn.reasonText = 'stopped by the user';
        const abort = this.aborters.get(id);
        if (abort) abort.abort();
        for (const t of this.store.data.tasks) {
          if (t.assignee === id && t.status === 'doing') {
            t.status = 'todo';
            t.assignee = undefined;
            t.updatedAt = Date.now();
            this.upsertTask(t);
          }
        }
        this.setAgent(id, { active: false, state: 'idle', activity: 'off shift', station: 'lounge' });
        this.afterTasksChanged();
        return { ok: true };
      }
      case 'spawn': {
        this.setAgent(id, { active: true, state: 'idle', activity: 'idle' });
        if (msg.arg) this.startWorker(id, String(msg.arg));
        else this.assignOpenTasks();
        return { ok: true };
      }
      default:
        return { ok: false, error: `unknown agent action ${String(msg.action)}` };
    }
  }
}
