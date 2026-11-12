// The team tools: how a Hermes agent (lead or worker) acts on the studio.
//
// The engine exposes these to the agent as an MCP server (`agentcraft`) registered in the
// per-agent HERMES_HOME config.yaml, so inside Hermes they are `mcp_agentcraft_<name>`. The
// engine validates each call against the tool's zod `shape`, serves it over a Unix socket, and
// runs the handler here, in this process, against live state — which is what makes `ask_user`
// really block a turn until the user answers in the world.
import { z } from 'zod';
import type { AgentTool, StudioApi, ToolHooks, ToolResult, TurnHandle } from './types.js';
import type { Decision, DiffFile, Task, TaskStatus } from './protocol.js';

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const err = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${name} is required`);
  return v.trim();
};

const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' ? (v as Record<string, any>) : {});

const STATUSES: TaskStatus[] = ['todo', 'doing', 'review', 'blocked', 'done', 'cancelled'];

/** A unified-diff rendering of the parsed diff, for a worker to read its own work. */
function renderDiff(files: DiffFile[]): string {
  const out: string[] = [];
  for (const f of files) {
    out.push(`${f.status} ${f.oldPath ? `${f.oldPath} -> ${f.path}` : f.path} (+${f.additions}/-${f.deletions})`);
    if (f.binary) {
      out.push('  (binary)');
      continue;
    }
    for (const h of f.hunks) {
      out.push(h.header);
      for (const l of h.lines) out.push(`${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}${l.text}`);
    }
  }
  return out.join('\n');
}

export function agentTools(
  studio: StudioApi,
  agentId: string,
  role: 'lead' | 'worker',
  hooks: ToolHooks,
  turn?: TurnHandle,
): AgentTool[] {
  const taskOf = (taskId?: string): Task | undefined => {
    const tasks = studio.store.data.tasks;
    if (taskId) return tasks.find((t) => t.id === taskId);
    return tasks.find((t) => t.assignee === agentId && (t.status === 'doing' || t.status === 'review'));
  };

  const board = (): string =>
    studio.store.data.tasks
      .map((t) => `${t.id} [${t.status}]${t.assignee ? ` @${t.assignee}` : ''} ci=${t.ci}${t.worktree ? ` wt=${t.worktree}` : ''} :: ${t.title}`)
      .join('\n') || '(no tasks)';

  const tools: AgentTool[] = [
    {
      name: 'write_memory',
      description: 'Write a markdown note the whole team (scope "shared") or one agent can read later.',
      shape: {
        scope: z.string().describe('"shared" or an agent id'),
        title: z.string().describe('short name, becomes the file name'),
        body: z.string().describe('markdown'),
      },
      handler: async (args) => {
        const a = obj(args);
        const entry = studio.writeMemory({ scope: str(a.scope, 'scope'), title: str(a.title, 'title'), body: String(a.body ?? ''), author: agentId });
        studio.feed('memory', `${agentId} wrote memory ${entry.id}`, agentId);
        return ok(`Saved memory ${entry.id}.`);
      },
    },
    {
      name: 'read_memory',
      description: 'List memory notes in a scope, or read one by title (scope "shared" by default).',
      shape: {
        scope: z.string().optional().describe('"shared" or an agent id'),
        title: z.string().optional().describe('omit to list the notes'),
      },
      handler: async (args) => {
        const a = obj(args);
        const scope = typeof a.scope === 'string' ? a.scope : 'shared';
        const { titles, body } = studio.readMemory(scope, typeof a.title === 'string' ? a.title : undefined);
        if (!a.title) return ok(titles.map((t) => `- ${t}`).join('\n') || '(empty)');
        if (!body) return err(`no memory named "${String(a.title)}" in ${scope}`);
        return ok(body);
      },
    },
    {
      name: 'list_tasks',
      description: 'The task board: every task with its status, assignee and CI state.',
      shape: {},
      handler: async () => ok(board()),
    },
    {
      name: 'my_task',
      description: 'The task currently assigned to you (workers).',
      shape: {},
      handler: async () => {
        const t = taskOf();
        if (!t) return ok('(no task assigned to you right now)');
        return ok(
          `${t.id} [${t.status}] ${t.title}\n${t.description ?? ''}\nworktree: ${t.worktree ?? '-'} branch: ${t.branch ?? '-'} ci: ${t.ci}`,
        );
      },
    },
    {
      name: 'create_task',
      description: 'Lead only: add a task to the board and assign it.',
      shape: {
        title: z.string(),
        description: z.string().optional().describe('what "done" means, in enough detail for a worker'),
        assignee: z.string().optional().describe('agent id'),
        priority: z.number().optional(),
      },
      handler: async (args) => {
        if (role !== 'lead') return err('only the lead creates tasks');
        const a = obj(args);
        const title = str(a.title, 'title');
        const task: Task = {
          id: studio.store.nextId('t'),
          title,
          description: typeof a.description === 'string' ? a.description : undefined,
          status: 'todo',
          assignee: typeof a.assignee === 'string' ? a.assignee : undefined,
          deps: [],
          priority: typeof a.priority === 'number' ? a.priority : 0,
          ci: 'unknown',
          createdBy: agentId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          goalId: studio.currentGoalId(),
          repoId: studio.currentRepoId(),
        };
        studio.store.data.tasks.push(task);
        studio.upsertTask(task);
        studio.feed('task', `${agentId} created ${task.id}: ${title}`, agentId);
        hooks.onTasksChanged();
        return ok(`Created ${task.id}.`);
      },
    },
    {
      name: 'update_task',
      description:
        'Move a task: doing (you start it), review (you are done — CI runs and the merge is requested), blocked (say why in summary).',
      shape: {
        taskId: z.string().optional().describe('omit for your own task'),
        status: z.enum(['todo', 'doing', 'review', 'blocked', 'done', 'cancelled']),
        summary: z.string().optional(),
      },
      handler: async (args) => {
        const a = obj(args);
        const task = taskOf(typeof a.taskId === 'string' ? a.taskId : undefined);
        if (!task) return err('no such task (or none assigned to you)');
        const status = str(a.status, 'status') as TaskStatus;
        if (!STATUSES.includes(status)) return err(`bad status ${status}`);
        task.status = status;
        task.updatedAt = Date.now();
        if (typeof a.summary === 'string') task.summary = a.summary;
        if (status === 'doing' && !task.assignee) task.assignee = agentId;
        studio.upsertTask(task);
        studio.feed('task', `${agentId}: ${task.id} ${status}${a.summary ? ` — ${String(a.summary).slice(0, 90)}` : ''}`, agentId);
        if (status === 'review') hooks.onReview(agentId, task.id);
        hooks.onTasksChanged();
        return ok(`Updated ${task.id}: ${status}.`);
      },
    },
    {
      name: 'send_message',
      description: 'Say something to another agent (or "all"). They see it as a speech bubble and in the feed.',
      shape: { to: z.string(), text: z.string() },
      handler: async (args) => {
        const a = obj(args);
        studio.say(agentId, str(a.text, 'text'), str(a.to, 'to'));
        return ok(`Sent to ${String(a.to)}.`);
      },
    },
    {
      name: 'say',
      description: 'Say something out loud in the room — a speech bubble above you (to the user by default).',
      shape: { text: z.string(), to: z.string().optional().describe('agent id, "user" or "all"') },
      handler: async (args) => {
        const a = obj(args);
        studio.say(agentId, str(a.text, 'text'), typeof a.to === 'string' ? a.to : 'user');
        return ok('Said.');
      },
    },
    {
      name: 'ask_user',
      description: `Ask ${studio.config.userName} something and wait for the answer. Use it whenever a choice is theirs.`,
      shape: {
        question: z.string(),
        options: z.array(z.string()).optional().describe('button labels; the first is the recommended one'),
      },
      handler: async (args) => {
        const a = obj(args);
        const question = str(a.question, 'question');
        const options = Array.isArray(a.options) && a.options.length ? a.options.map(String) : ['Yes', 'No'];
        const decision: Decision = {
          id: studio.store.nextId('d'),
          agentId,
          kind: 'question',
          question,
          options,
          status: 'open',
          createdAt: Date.now(),
        };
        studio.store.data.decisions.push(decision);
        studio.upsertDecision(decision);
        studio.feed('decision', `${agentId} asks: ${question}`, agentId);
        studio.notify('need_user', `${agentId} asks: ${question}`, decision.id);
        hooks.onWaiting(agentId, true);
        const answer = await studio.waitForDecision(decision.id, turn);
        hooks.onWaiting(agentId, false);
        if (!answer) return err('the question was withdrawn (the turn ended)');
        return ok(`${studio.config.userName} answered: ${answer}`);
      },
    },
    {
      name: 'read_diff',
      description: "The diff of a task's worktree against its base branch.",
      shape: { taskId: z.string().optional().describe('omit for your own task') },
      handler: async (args) => {
        const a = obj(args);
        const task = taskOf(typeof a.taskId === 'string' ? a.taskId : undefined);
        if (!task?.worktree || !task.repoId) return err('that task has no worktree yet');
        try {
          const d = await studio.repos.diff(task.repoId, task.worktree);
          const files = d.files.map((f) => `${f.status} ${f.path} +${f.additions}/-${f.deletions}`).join('\n');
          return ok(`files:\n${files || '(none)'}\n\n${renderDiff(d.files).slice(0, 24000)}`);
        } catch (e) {
          return err(`diff failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    },
    {
      name: 'run_ci',
      description: "Run the repo's test command in a task's worktree and report the result.",
      shape: { taskId: z.string().optional().describe('omit for your own task') },
      handler: async (args) => {
        const a = obj(args);
        const task = taskOf(typeof a.taskId === 'string' ? a.taskId : undefined);
        if (!task?.worktree || !task.repoId) return err('that task has no worktree yet');
        const res = await studio.repos.runTests(task.repoId, task.worktree);
        task.ci = res.pass ? 'pass' : 'fail';
        task.updatedAt = Date.now();
        studio.upsertTask(task);
        studio.feed('ci', `CI ${task.ci} for ${task.id} (${(res.durationMs / 1000).toFixed(1)}s)`, agentId);
        return ok(res.pass ? `CI passed: ${res.command}\n${res.output.slice(0, 4000)}` : `CI failed: ${res.command}\n${res.output.slice(0, 4000)}`);
      },
    },
    {
      name: 'request_merge',
      description:
        'Ask for a finished task to be merged into the base branch. The user decides, unless this repo is an experiment repo with auto-merge on.',
      shape: { taskId: z.string() },
      handler: async (args) => {
        const a = obj(args);
        const res = await studio.requestMerge(str(a.taskId, 'taskId'), agentId);
        return res.merged ? ok(`Merged into ${res.branch}.`) : ok(`Not merged: ${res.reason}`);
      },
    },
  ];

  return tools;
}
