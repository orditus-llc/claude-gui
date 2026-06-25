# claude-gui

See your Claude Code chats. Grab the session ID. Resume. Delete junk.

```bash
node ~/claude-gui/index.js     # or: claude-gui
```

Opens in browser. Reads `~/.claude/projects/*/*.jsonl`. Zero installs.

## Us vs the others

| | claude-gui | claude-code-viewer | claude-code-trace | claude-sessions-cli |
|---|---|---|---|---|
| Type | web | web | app/web | terminal |
| License | MIT | MIT | MIT | MIT |
| Zero deps | ✓ | | | |
| List all chats | ✓ | ✓ | ✓ | ✓ |
| See session ID | ✓ | ✓ | | |
| Copy resume code | ✓ | ✓ | | ✓ |
| Read the chat | ✓ | ✓ | ✓ | |
| Search | ✓ | ✓ | ✓ | ✓ |
| Delete chat | ✓ | | | ✓ |
| Clean junk | | | | ✓ |
| Live watch | | ✓ | ✓ | |
| In-app chat | | ✓ | | |
| Token/cost | | | ✓ | |
| WSL | ✓ | ✓ | ✓ | ✓ |

## Why this one

Small. One file. No deps. Does the 3 things at once: read chat + copy resume + delete. No other tool does all 3.

## TODO

- [ ] **Subagent drill-in** — click a Task/subagent badge in a chat, open that agent's own transcript (`~/.claude/projects/<project>/<id>/subagents/agent-*.jsonl`).
- [ ] **Archive** — hide a chat with a reversible move instead of delete-forever (own flair to add).
