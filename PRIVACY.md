# Privacy

Opening smodel reads the local model registry and checks which provider CLIs exist.
Sending reads the current Claude conversation: Claude forks its original session context;
Codex and agy use extracted user/assistant text, excluding tool blocks and harness noise.
The chosen CLI sends context and side-chat messages to its configured provider's service
(Anthropic for Claude, OpenAI for Codex, typically Google for Gemini via agy).
The first-send notice names the provider. CLI authentication, billing, and provider retention apply.

By default, quota display reads ~/.claude/rate-limit-state.json if present and quota events
from up to five recent ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl files.
Disable "Show account limits" (showLimits=false) in /config to skip these reads.
Quota collection makes no model call; only reported quota numbers are displayed.

Refresh writes ~/.claude/model-registry.json, shared with any existing daily updater.
Side-chat messages, context/history, answers, logs, raw CLI results, Claude fork identifiers,
and statistics are stored under ~/.claude/smodel-chats/<session>/<provider>-<model>/.
These files can contain sensitive conversation content. There is no automatic expiration.
Wait for turns to finish and close chats, then delete that session folder, or delete
~/.claude/smodel-chats/ to remove all saved chat files. Reload/end the Claude session
to clear pane messages; Claude Code can also retain its own plugin/session state.
Deleting chat files does not delete original transcripts, provider records, or CLI session files.
Consult provider policies and CLI controls for their retention and deletion rules.

Claude tools/MCP/slash commands are disabled; Codex uses a read-only sandbox.
agy is instructed to consult only, but this plugin does not enforce a read-only sandbox for it.
