# Project: Claude Monitor with implementation reference

## Purpose and scope

Claude Monitor adds a live view to the workspace manager that shows, per workspace, whether each Claude Code session is working, waiting for input, finished or failed. Today that information is only visible by clicking through up to 8 VS Code windows and their terminals.

The feature has two parts:

- **Event endpoint and state store:** the web app receives lifecycle events that Claude Code pushes over HTTP and keeps one state record per session.
- **Hook installer:** the web app writes the required hook configuration into the local Claude Code user settings, so no manual editing is needed.

No process inspection, terminal scraping or VS Code extension is involved. Claude Code runs unchanged in the integrated terminal.

## How it works

Claude Code hooks push every relevant lifecycle event to one endpoint in the web app. A hook is an entry in a Claude Code settings file that names an event and a handler. Handlers of type `http` POST the event's JSON to a URL; handlers of type `command` run a shell command with the same JSON on stdin.

Hooks defined in the user settings file apply to every session on the machine, so one installation covers all workspaces. The monitor subscribes to these events:

| Event | Handler | Why |
| --- | --- | --- |
| `SessionStart` | `command` (curl) | Registers the session before the first prompt. This event does not support `http` handlers. |
| `UserPromptSubmit` | `http` | A turn started. |
| `PreToolUse` | `http` | A tool call is starting; gives the current activity. |
| `PermissionRequest` | `http` | Claude is about to ask for approval. Fires immediately. |
| `PostToolUse`, `PostToolUseFailure` | `http` | A tool call ended; work continues. |
| `Notification`, matcher `permission_prompt\|elicitation_dialog\|elicitation_url_dialog` | `http` | Prompts that `PermissionRequest` does not cover (MCP input forms, sandbox network requests). Arrives after about 6 seconds without typing. |
| `Stop` | `http` | The turn finished. |
| `StopFailure` | `http` | The turn ended with an API error. |
| `SessionEnd` | `http` | The session closed. |

All handlers point at the same URL. The endpoint tells events apart by the `hook_event_name` field in the body.

## Event payloads

Every event carries the same core fields, plus a few that are specific to the event. Treat every field except `session_id` and `hook_event_name` as optional, and ignore unknown fields: the schema grows with Claude Code releases.

| Field | On | Use |
| --- | --- | --- |
| `session_id` | all | Primary key of the session record. |
| `hook_event_name` | all | Selects the state transition. |
| `cwd` | all | Current working directory; used for workspace matching. Changes when Claude runs `cd`. |
| `transcript_path` | all | Path to the session transcript. Not needed; do not parse it. |
| `agent_type` | when started with `--agent`, or inside a subagent | Display label. |
| `agent_id` | only inside a subagent | Marks the event as subagent activity. |
| `source` | `SessionStart` | `startup`, `resume`, `clear`, `compact` or `fork`. |
| `session_title` | `SessionStart`, `UserPromptSubmit` | Custom title set with `--name` or `/rename`; display label. |
| `model` | `SessionStart` (sometimes omitted) | Optional display. |
| `prompt` | `UserPromptSubmit` | Text of the prompt; a short excerpt makes a fallback label. |
| `tool_name`, `tool_input` | tool events, `PermissionRequest` | Current activity, and what is being asked for. |
| `message`, `notification_type` | `Notification` | Text and type of the prompt Claude is showing. |
| `last_assistant_message` | `Stop`, `StopFailure` | Claude's final text of the turn, or the error text; shown as a preview. |
| `background_tasks`, `session_crons` | `Stop` | Non-empty arrays mean the session will wake up again by itself. |
| `error`, `error_details` | `StopFailure` | Error type such as `rate_limit` or `server_error`. |
| `reason` | `SessionEnd` | `clear`, `resume`, `logout`, `prompt_input_exit` or `other`. |

A `Stop` event looks like this:

```json
{
  "session_id": "abc123",
  "transcript_path": "/home/user/.claude/projects/.../abc123.jsonl",
  "cwd": "/home/user/workspaces/my-workspace/repo-a",
  "permission_mode": "default",
  "hook_event_name": "Stop",
  "stop_hook_active": false,
  "last_assistant_message": "I've completed the refactoring. Here's a summary...",
  "background_tasks": [],
  "session_crons": []
}
```

Bodies can be large. `PreToolUse` and `PostToolUse` carry the full tool input and result, which for a file write is the whole file. Accept bodies of several megabytes and read only the fields listed above.

## Endpoint contract

The web app exposes one write endpoint for Claude Code and one read endpoint for its own UI. Paths and port below are suggestions; the installer writes whatever the app actually uses.

**`POST /claude-monitor/events`** receives hook events.

- **Always answer 204 with an empty body**, also for unknown events, unknown sessions and internal errors. Claude Code interprets a JSON response body as hook output, and on `PreToolUse`, `PermissionRequest` and `Stop` that output can approve, deny or block. A non-JSON body is reported in the session as a hook error.
- **Answer fast.** Claude Code waits for the response before it continues, on every tool call. Update the in-memory record and return; target under 50 ms. The installed handlers carry a 2-second timeout as a safety net.
- **Bind to loopback only.** Bodies contain prompts, shell commands and file contents. Do not log or persist full bodies.
- **Require `Content-Type: application/json` and send no CORS headers on this route**, so that a web page open in the browser cannot post fake events.
- **Upsert on every event.** A session may first appear with any event, for example when the app started after the session did.

**`GET /claude-monitor/sessions`** returns the current session records for the UI. A server-sent events stream of changes is a good addition; polling every 2 seconds is sufficient to start.

Suggested session record:

| Field | Content |
| --- | --- |
| `session_id` | From the events. |
| `workspace_id` | Matched workspace, or null. |
| `cwd` | Working directory of the first event seen. |
| `state` | `idle`, `working`, `waiting`, `done` or `failed`. |
| `state_since`, `last_event_at` | Timestamps set by the server. |
| `title`, `agent_type`, `first_prompt` | Label sources, in that order of preference. `first_prompt` is cut to about 80 characters. |
| `activity` | Last `tool_name` plus a one-line summary, for example the Bash command. |
| `preview` | `last_assistant_message`, cut to about 300 characters. |
| `error` | `error` and `error_details` of the last `StopFailure`. |
| `wakes_itself` | True when the last `Stop` had background tasks or scheduled wakeups. |
| `unseen` | True from the moment the session enters `waiting`, `done` or `failed` until the user acknowledges it. |

## Session state model

Each session is in exactly one of five states, and each incoming event maps to at most one transition.

&#91;embedded content: session states · 5 states, transitions by hook event\]

The three coloured states are the ones the user must react to. A session in `done` or `failed` returns to `working` with the next prompt.

| Event | Condition | New state | Also update |
| --- | --- | --- | --- |
| `SessionStart` | session unknown | `idle` | title, agent type, model; match the workspace |
| `SessionStart` | session known | unchanged | title, agent type, model |
| `UserPromptSubmit` |  | `working` | clear `unseen`, `preview` and `error`; set `first_prompt` if empty |
| `PreToolUse` |  | `working` | `activity` |
| `PermissionRequest` |  | `waiting` | `activity` (the tool being asked for); set `unseen` |
| `Notification` |  | `waiting` | store `message`; set `unseen` |
| `PostToolUse`, `PostToolUseFailure` |  | `working` |  |
| `Stop` |  | `done` | `preview`, `wakes_itself`; set `unseen` |
| `StopFailure` |  | `failed` | `error`; set `unseen` |
| `SessionEnd` |  | record removed |  |
| any other |  | unchanged | `last_event_at` only |

Three rules deserve attention:

- **`SessionStart` must not reset a known session.** It also fires in the middle of a turn after context compaction, with `source` set to `compact`.
- **`done` means "your turn", not "task complete".** `Stop` fires at the end of every turn, including when Claude ends with a question. The preview text lets the user tell the two apart.
- **Events from subagents follow the same table.** They carry an `agent_id` and count as activity of the parent session. `SubagentStop` is deliberately not subscribed.

## Workspace matching

A session belongs to the workspace whose root folder contains the `cwd` of the first event seen for that session. The match is made once and stored on the session record.

1. Normalise both paths: resolve symlinks, unify separators, drop trailing separators, and compare case-insensitively on Windows and macOS.
2. Match by whole path segments, so `/ws/app` does not match `/ws/app-old`.
3. If several workspace roots match, the longest one wins.
4. Do not re-match on later events. `cwd` follows Claude into the cloned repositories and occasionally outside the workspace; the session still belongs where it started.
5. If nothing matches, keep the session with a null workspace and list it under "Other sessions" with its `cwd`. Retry the match when the workspace list changes.

A workspace can hold several sessions, one per agent terminal. The workspace status is the most urgent state among them, in this order: `waiting`, `failed`, `done` (unseen), `working`, `done` (seen), `idle`.

Session labels use the first available of: `title`, `agent_type`, `first_prompt`, then the first 8 characters of `session_id`.

## Hook installer

The web app installs, updates and removes its own hook entries in the Claude Code user settings file, and leaves everything else in that file untouched.

### Target file

The user settings file is `~/.claude/settings.json`, which on Windows is `%USERPROFILE%\.claude\settings.json`. If the environment variable `CLAUDE_CONFIG_DIR` is set, the file is `settings.json` in that directory instead. Make the path overridable in the app's configuration.

Do not write to `.claude/settings.json` inside workspaces or repositories. Those files are project settings and may be committed.

### Entries to write

This is the complete block for an app listening on port 8080. The installer substitutes its real base URL.

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "async": true, "command": "curl -s -m 2 -o /dev/null -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:8080/claude-monitor/events || true" } ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "http", "url": "http://127.0.0.1:8080/claude-monitor/events", "timeout": 2 } ] }
    ],
    "PreToolUse": [
      { "hooks": [ { "type": "http", "url": "http://127.0.0.1:8080/claude-monitor/events", "timeout": 2 } ] }
    ],
    "PermissionRequest": [
      { "hooks": [ { "type": "http", "url": "http://127.0.0.1:8080/claude-monitor/events", "timeout": 2 } ] }
    ],
    "PostToolUse": [
      { "hooks": [ { "type": "http", "url": "http://127.0.0.1:8080/claude-monitor/events", "timeout": 2 } ] }
    ],
    "PostToolUseFailure": [
      { "hooks": [ { "type": "http", "url": "http://127.0.0.1:8080/claude-monitor/events", "timeout": 2 } ] }
    ],
    "Notification": [
      {
        "matcher": "permission_prompt|elicitation_dialog|elicitation_url_dialog",
        "hooks": [ { "type": "http", "url": "http://127.0.0.1:8080/claude-monitor/events", "timeout": 2 } ]
      }
    ],
    "Stop": [
      { "hooks": [ { "type": "http", "url": "http://127.0.0.1:8080/claude-monitor/events", "timeout": 2 } ] }
    ],
    "StopFailure": [
      { "hooks": [ { "type": "http", "url": "http://127.0.0.1:8080/claude-monitor/events", "timeout": 2 } ] }
    ],
    "SessionEnd": [
      { "hooks": [ { "type": "http", "url": "http://127.0.0.1:8080/claude-monitor/events", "timeout": 1 } ] }
    ]
  }
}
```

Notes on the block:

- **`SessionStart` uses curl** because that event accepts only `command` and `mcp_tool` handlers. The command forwards the event JSON from stdin, discards the response and runs in the background. It needs curl and a POSIX shell: macOS, Linux, or Windows with Git Bash.
- **Never add `"onFailure": "block"`.** With it, a stopped web app would block tool calls and prompts.
- **`SessionEnd` has a total budget of 1.5 seconds** for all its hooks, hence the shorter timeout.

### Algorithm

A handler is owned by the monitor when its `url` or `command` contains the path `/claude-monitor/events`. This marker makes every operation idempotent and independent of the port.

1. Resolve the settings path. If the file does not exist, start from `{}` and create the directory.
2. Parse the file as strict JSON. If parsing fails, stop, report the error and change nothing. Claude Code settings files allow neither comments nor trailing commas.
3. Copy the current file to a timestamped backup next to it.
4. Remove every owned handler. Then remove matcher groups whose `hooks` array is empty, event keys whose array is empty, and the `hooks` key if it is empty.
5. For install or update, append one matcher group per event from the block above. Do not merge into groups that belong to other tools.
6. Write the result with 2-space indentation to a temporary file in the same directory and rename it over the original. Keep all other keys and their order.

Uninstall is steps 1 to 4 and 6.

### Status check

The app shows one of four results, computed by reading the file without changing it:

| Status | Condition |
| --- | --- |
| Not installed | No owned handler found. |
| Installed | Owned handlers equal the block the app would write now. |
| Outdated | Owned handlers exist but differ, for example after a port change. Offer "Update". |
| Settings file invalid | The file is not valid JSON. Show the parser message. |

Two keys in the same file get a warning next to the status: `disableAllHooks` set to `true`, and an `allowedHttpHookUrls` list that does not cover the event URL.

### Activation

Claude Code watches its settings files, so running sessions normally pick up the change without a restart. Hooks from settings files run only in folders where the workspace trust dialog was accepted, which is the case for any folder already in use.

To confirm from the Claude Code side, run `/hooks` in a session. It lists every active hook with its source file.

## UI behaviour

The monitor answers one question at a glance: which workspace needs me now.

- **Workspace list:** each workspace shows a status badge derived from its sessions, as defined under Workspace matching.
- **Session rows:** label, state, time in the current state, and one line of detail. The detail is `activity` while working or waiting, `preview` when done, and `error` when failed.
- **Self-waking sessions:** a `done` session with `wakes_itself` set shows a "background work running" marker, because it will continue without the user.
- **Quiet sessions:** a `working` session with no event for 10 minutes, whose last event was not `PreToolUse`, shows a "quiet" marker. This covers interrupted turns, described under Edge cases.
- **Acknowledging:** opening a workspace or clicking a session clears `unseen`. So does the next prompt in that session.
- **Alerts:** the page title carries the number of unseen sessions, for example "(2) Workspaces". On a transition into `waiting`, `done` or `failed` the page raises a browser notification with the workspace name and the detail line.
- **Focus button:** each workspace gets a button that makes the backend run `code <workspace folder>`. VS Code then brings the window that already has this folder open to the front instead of opening a new one.

## Edge cases and constraints

The event stream has gaps, and the state model has to tolerate them.

| Situation | What happens | Handling |
| --- | --- | --- |
| User interrupts a turn with Esc | `Stop` is not sent. The session stays `working`. | The "quiet" marker; the next prompt corrects the state. |
| Terminal or VS Code window is killed | `SessionEnd` may not be sent. | Remove records without events for 12 hours (configurable) and offer a manual dismiss. |
| `/clear` or `/resume` inside a session | `SessionEnd`, then `SessionStart`, possibly with a new `session_id`. | Nothing special: remove on end, upsert on start. |
| Permission denied by the user | No `PostToolUse` for that call. | State leaves `waiting` with the next `PreToolUse` or `Stop`. |
| Parallel tool calls | A `PostToolUse` of one call can arrive while another call waits for approval, which flips the state to `working`. | The `Notification` event re-asserts `waiting` after about 6 seconds. Accepted inaccuracy. |
| Web app restarts | In-memory records are lost. | Sessions reappear with their next event. Persist the records if that proves annoying. |
| Web app is not running | Each hook call fails to connect. Claude Code treats that as a non-blocking error and continues. | None needed for correctness. See the open points for how visible this is. |
| Sessions outside the terminal | The VS Code extension and the desktop app fire the same hooks. | They appear in the monitor like any other session. |

**Organisation policy can disable the feature.** With a company-managed Claude Code installation, administrators can set `allowManagedHooksOnly`, which blocks all user-level hooks, or an `allowedHttpHookUrls` list that restricts where `http` hooks may post. The installer cannot override either. If `/hooks` does not list the monitor's entries after installation, this is the likely cause.

## Acceptance checklist and open points

The feature is complete when every item below passes on the target machine.

- [ ] The event endpoint answers 204 with an empty body to valid events, unknown events and malformed JSON.
- [ ] A session shows `working` within a second of sending a prompt and `done` when the turn ends, with a preview.
- [ ] A permission prompt shows `waiting` immediately, and `working` again after approval.
- [ ] A posted sample `StopFailure` event shows `failed` with the error type.
- [ ] Two sessions in one workspace appear as two rows under that workspace.
- [ ] A session started in a repository subfolder is assigned to the enclosing workspace.
- [ ] Installing twice produces an identical settings file.
- [ ] Hooks and settings from other tools survive install, update and uninstall unchanged.
- [ ] An invalid settings file is reported and not modified.
- [ ] With the web app stopped, Claude Code sessions keep working normally.
- [ ] The Focus button brings the right VS Code window to the front.

Three points could not be settled from documentation and need a test:

1. **Visibility of failed hook calls.** The documentation states that a failed connection does not block anything. It does not state whether the terminal shows a notice for each failed call while the web app is stopped. If it does and that is disruptive, switch the `http` handlers to the curl form used for `SessionStart`, which ends in "|| true" and so never reports a failure.
2. **Focus behaviour of `code <folder>`.** Reusing the existing window is standard VS Code behaviour, but confirm it on the target operating system.
3. **Organisation policy.** Confirm with `/hooks` that user-level hooks are permitted under the company's managed settings.

## References

All Claude Code behaviour described here was checked against the official documentation on 20 November 2026. Hook events and fields are extended frequently, so re-check the reference when something behaves differently.

- [Hooks reference](https://code.claude.com/docs/en/hooks): events, payload schemas, handler types, HTTP response handling, timeouts.
- [Hooks guide](https://code.claude.com/docs/en/hooks-guide): walkthrough and troubleshooting.
- [Settings](https://code.claude.com/docs/en/settings): settings file locations, format and precedence.
- [Environment variables](https://code.claude.com/docs/en/env-vars): `CLAUDE_CONFIG_DIR` and others.
