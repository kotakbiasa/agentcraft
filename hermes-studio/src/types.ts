// Shared types for the Hermes-native studio.
//
// This is the type surface the Foreman used to spread over `agents/engine.ts`, `agents/tools.ts`
// and `config.ts`, reduced to what a Hermes-only system needs: an engine runs one agent turn,
// the studio owns everything around it (state, worktrees, CI, merges, the protocol).
import type { ChildProcess } from 'node:child_process';
import type { z } from 'zod';
import type { Agent, Decision, FeedKind, LogKind, MemoryEntry, Outbound, Task } from './protocol.js';
import type { Store } from './store.js';
import type { RepoManager } from './repos.js';
import type { Logger } from './context.js';

export type EngineId = 'hermes';
export type Role = 'lead' | 'worker';

export interface TurnStats {
  /** the engine's session id, to resume the next turn of the same agent */
  sessionId?: string;
  resultText?: string;
  subtype?: string;
  isError: boolean;
  numTurns?: number;
  /** total tokens of the turn (engines that report usage) */
  tokens?: number;
  authFailed?: string;
  errors: string[];
}

/** The verdict on one tool call: allow it, or refuse it with a message the agent sees. */
export type PermissionAnswer = { allow: true } | { allow: false; message: string };

export type PermissionGate = (
  toolName: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
  title?: string,
) => Promise<PermissionAnswer>;

/** Lets a tool ask why its turn is being ended (abort/timeout). */
export interface TurnHandle {
  /** aborted when the turn must stop changing the world */
  signal: AbortSignal;
  reason(): string | undefined;
}

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export interface AgentTool {
  name: string;
  description: string;
  /** zod raw shape: the engine validates the call and derives the JSON Schema the model sees */
  shape: Record<string, z.ZodTypeAny>;
  handler(args: any): Promise<ToolResult>;
}

export interface TurnSpec {
  agentId: string;
  role: Role;
  /** lead: the user's checkout (read-only); worker: its worktree */
  cwd: string;
  prompt: string;
  /** role, rules and worktree, added to the engine's own system prompt */
  instructions: string;
  /** the engine session to continue (from TurnStats.sessionId), if any */
  resume?: string;
  /** environment for the agent's process and every command it runs (git safety, identity) */
  env: Record<string, string | undefined>;
  /** directories the agent may write besides cwd (a worktree's git dir, for commits) */
  writableRoots?: string[];
  abort: AbortController;
  turn: TurnHandle;
  permission: PermissionGate;
  tools: AgentTool[];
  /** the agent process the engine spawned, so the studio can end its whole tree on abort */
  onProcess(child: ChildProcess): void;
  /** the session id, as soon as the engine knows it (persisted for resume) */
  onSession(sessionId: string): void;
  /** the model the turn really runs, as soon as the engine knows it */
  onModel?(model: string): void;
}

export type AuthCheck = { ok: true; account: string } | { ok: false; message: string };

export interface Engine {
  readonly id: EngineId;
  readonly label: string;
  model(role: Role): string;
  checkAuth(): Promise<AuthCheck>;
  runTurn(spec: TurnSpec): Promise<TurnStats>;
  authFailedMessage(detail: string): string;
}

/** What a tool does to the world beyond its return value. */
export interface ToolHooks {
  onReview(agentId: string, taskId: string): void;
  onChangesRequested(taskId: string, feedback: string): void;
  onTasksChanged(): void;
  onMergeRequested(taskId: string, decision: Decision): void;
  onWaiting(agentId: string, waiting: boolean): void;
}

/** What the Hermes engine reads from the config. */
export interface HermesConfig {
  path?: string;
  leadModel?: string;
  workerModel?: string;
  /** inference provider for the turns (a custom provider name from the user's config) */
  provider?: string;
  leadProvider?: string;
  workerProvider?: string;
  effort?: string;
  leadEffort?: string;
  yolo: boolean;
}

export interface StudioConfig {
  /** the repo root (the MCP bridge lives in <projectRoot>/hermes-studio/scripts) */
  projectRoot: string;
  /** where state, worktrees and agent homes live (AGENTCRAFT_HOME) */
  dataDir: string;
  port: number;
  maxTurnsLead: number;
  maxTurnsWorker: number;
  leadModel?: string;
  workerModel?: string;
  /** inference provider for the turns (e.g. a custom provider name from the user's config) */
  provider?: string;
  leadProvider?: string;
  workerProvider?: string;
  effort?: string;
  leadEffort?: string;
  yolo: boolean;
  /** repo ids where a green CI merges without asking the user ("all" = every repo) */
  autoMerge: Set<string>;
  /** worker agent ids on shift (the lead is always on) */
  workers: Set<string>;
  userName: string;
}

/** The service surface the Hermes engine and its stream mapper touch. */
export interface Studio {
  readonly config: StudioConfig;
  readonly store: Store;
  readonly log: Logger;
  readonly repos: { scheduleRefresh(repoId: string, delayMs?: number): void };
  emit(msg: Outbound): void;
  agent(id: string): Agent | undefined;
  setAgent(id: string, patch: Partial<Agent>): void;
  agentLog(id: string, kind: LogKind, text: string): void;
}

/** What the team tools need beyond the engine's surface (the concrete studio satisfies this). */
export interface StudioApi extends Studio {
  readonly repos: RepoManager;
  notify(level: 'info' | 'warn' | 'need_user', text: string, decisionId?: string): void;
  currentGoalId(): string | undefined;
  currentRepoId(): string | undefined;
  writeMemory(input: { scope: string; title: string; body: string; author: string }): MemoryEntry;
  readMemory(scope: string, title?: string): { titles: string[]; body?: string };
  upsertTask(task: Task): void;
  upsertDecision(d: Decision): void;
  feed(kind: FeedKind, text: string, agentId?: string, to?: string): void;
  say(agentId: string, text: string, to?: string): void;
  waitForDecision(id: string, turn?: TurnHandle): Promise<string | undefined>;
  requestMerge(
    taskId: string,
    by?: string,
  ): Promise<{ merged: boolean; reason: string; decisionId?: string; sha?: string; branch?: string }>;
}
