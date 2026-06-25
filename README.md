<div align="center">

# claude-gui

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat-square&logo=javascript&logoColor=black)](https://developer.mozilla.org/docs/Web/JavaScript)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-22C55E?style=flat-square)](package.json)
![License](https://img.shields.io/badge/license-MIT-22C55E?style=flat-square)

**Lightweight GUI for Claude Code sessions. Zero dependencies.**

Browse, search, resume, and clean up your sessions in one local web page.<br>
The `claude -- resume` hides session IDs --> this doesn't.

</div>

## Install

> Install where you run Claude Code
   - `Claude Code in WSL → install in **WSL**`
   - `Claude Code in Windows → install in **PowerShell**`

```bash
npm install -g github:orditus-llc/claude-gui
```

## Usage

```bash
claude-gui        # opens http://localhost:3131
claude-gui 8080   # custom port
```

## Features

- Find **all** Claude Code sessions, across **all** projects
  - **Full conversations**, collapsible, skimmable
- Quickly resume any session
  - Filter, pin, & delete
  - Skim context window & file size
- Read and **EDIT** project memory
- **Customize** session retention period

## Development

Want to edit it? Clone anywhere (your Windows drive is fine for VSCode/Git), then install:

```bash
git clone https://github.com/orditus-llc/claude-gui.git
cd claude-gui
npm install -g .   # or: npm link (live edits)
```

claude-gui reads `~/.claude/projects` in whatever environment it runs in, so it shows the sessions for **that** environment. Run it where you run Claude Code — WSL for WSL sessions, PowerShell for Windows sessions. Want both? Run both: WSL defaults to port 3131, Windows to 3132, so they don't collide.

## How it works

One Node server, one HTML page. Reads `~/.claude/projects/*.jsonl`. Writes only on your action (delete, edit memory, pin, retention), to a local `claude-gui-data.json`.

## Requirements

Node 18+ & a browser

Linux, Windows (WSL or native), or macOS (Not Tested)

## License

MIT

## Future Features (To Do)

- [ ] Add subagent sessions
- [ ] Archive (reversible delete)
- [ ] Compress old conversations
