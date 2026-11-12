# hermes-studio

The Hermes-native AgentCraft backend. It replaces the Foreman's brain: instead of a hardcoded
orchestrator (`team.ts`, `taskgraph.ts`, `decisions.ts`, …) deciding who does what, **the lead is
a Hermes turn like any other** — it reads the goal, plans in shared memory, and creates tasks;
worker turns pick those tasks up in their own git worktrees.

The mod does not change: it still speaks protocol v1 over `ws://127.0.0.1:7878` and still renders
the same agents, task wall, decisions and feed.

```
you / console ─┐
               ├─ ws :7878 (protocol v1) ── hermes-studio ──┬─ repos: worktrees, CI, merges
Minecraft mod ─┘                                            ├─ store: tasks, goals, feed, memory
                                                           └─ HermesEngine: one `hermes chat --oneshot`
                                                              per turn, HERMES_HOME per agent,
                                                              team tools over a Unix socket (MCP)
```

## Run it

```sh
cd hermes-studio
AGENTCRAFT_HOME=~/.hermes-studio npm start -- \
  --repo ~/Projects/pocket-notes \
  --goal "add a --upper flag that prints the greeting in UPPERCASE" \
  --auto-merge pocket-notes        # experiment repo: green CI merges without asking
  --workers kit,wren               # who is on shift (the lead, Marlow, always is)
```

| flag | meaning |
| --- | --- |
| `--repo <path>` | register a local git repo (repeatable) |
| `--goal <text>` | submit a goal to the lead immediately |
| `--port <n>` | protocol port (default 7878) |
| `--data <dir>` | state dir (or `AGENTCRAFT_HOME`; default `~/.hermes-studio`) |
| `--workers <a,b>` | workers on shift; default `kit,wren` |
| `--model/--lead-model/--worker-model <m>` | model per role (default: the one in your Hermes config) |
| `--effort/--lead-effort <e>` | thinking effort |
| `--yolo` | skip the tool gate's asks (everything still passes through `policy.ts`) |
| `--auto-merge <id\|all>` | merge a green CI without asking the user. **Only for repos you own as experiments** |
| `--user-name <name>` | what the agents call you |

## What moved from the Foreman

Copied verbatim (the safety and transport half — deleting these would let agents write to repos
without worktrees or guards):

- `src/protocol.ts` — the v1 wire contract, generated docs live in `docs/protocol.md`
- `src/store.ts`, `src/context.ts` — state, feed, logs, the clock/sink every subsystem gets
- `src/repos.ts`, `src/gitsafety.ts`, `src/diff.ts` — worktrees, merges, `git push` blocking, identity
- `src/policy.ts` — the tool gate in front of every agent tool call
- `src/user.ts`, `src/util/*`, `src/cast.ts` — the user, git/proc/fs helpers, the shared cast
- `src/agents/hermes/{engine,home,stream}.ts` — the Hermes engine (one turn = one `hermes chat --oneshot`)
- `scripts/team-mcp.mjs` — the stdio↔Unix-socket MCP bridge that serves the team tools

Written new (the orchestration half):

- `src/studio.ts` — goals, tasks, assignment, CI, merge policy, the protocol surface, the tool gate
- `src/tools.ts` — the team tools (`write_memory`, `create_task`, `update_task`, `say`, `ask_user`, `read_diff`, `run_ci`, `request_merge`, …)
- `src/server.ts` — the protocol v1 WebSocket server (hello → snapshot → upserts)
- `src/index.ts` — CLI entry
- `assets-src/cast.json` — the real cast (colors/skins the mod renders)

## How a goal flows

1. `goal.submit` (console text, or `--goal`) → a `Goal` in the store, the lead's turn starts.
2. The lead plans: `write_memory` (scope `shared`), then `create_task` per unit of work.
3. Unassigned tasks go to a free on-shift worker; the worker gets a **git worktree**
   (`agentcraft/<agent>/<task>-<slug>`) and a turn prompt with its task.
4. The worker commits in its worktree and calls `update_task {status:"review"}`.
5. CI runs the repo's own test command in that worktree.
6. Green → merge. In an `--auto-merge` repo it merges immediately; otherwise the user gets a
   `merge` decision (Merge / Request changes / Reject) through the world.
7. Task done → goal progress; all tasks done → goal done, the lead says so out loud.

Everything the agents do is visible: the mod renders nameplates, activity, the task wall, the feed
and speech bubbles, and `ask_user` really blocks the turn until you answer in the world.

## Safety rules (unchanged from the Foreman)

- Agents never run in your checkout: workers get worktrees, the lead is read-only.
- `git push` and git network access are disabled in the agent environment (`gitsafety.ts`).
- Every tool call passes `policy.ts`; anything outside the agent's sandbox is refused with a
  message, and the sanctioned way to ask you anything is `ask_user`.
- Nothing merges into a repo without either a green CI **and** your approval — unless you put that
  repo on `--auto-merge`, which is meant for throwaway experiment repos only.

## Typecheck

```sh
cd hermes-studio && npx tsc --noEmit
```
