# Future Features (To Do)

Roadmap and proposed changes for claude-gui. The README links here instead of
carrying the list inline.

- [ ] Add an auxiliary/subagent session browser for Claude Code and Codex
- [ ] Archive (reversible delete)
- [ ] Compress old conversations
- [ ] Replace "Open With" with in-app file viewer ([details](#replace-open-with-with-in-app-file-viewer))

---

## Replace "Open With" with in-app file viewer

**Switch to in-app**

- Carried code: ~56 lines (~45% less)
- Cross-platform burden: none — plain `fs.readFileSync` + a modal reusing existing `renderMd`/`esc`/modal CSS

Switching is a net ~46 lines deleted and it removes the single most platform-fragile subsystem in the app — the only place it fights rundll32, WSL UNC paths, and 8.3 short paths. The new code only adds two trivial edge cases (a "binary, not previewable" notice and a large-file cap). It also makes your taskbar-foreground annoyance vanish entirely.

The one real loss: you'd view files read-only in the browser instead of opening them in VSCode/Notepad++ to edit. Since these are version-pinned cache files you shouldn't edit anyway, that's a small loss for peeking — but if opening-in-your-editor is a workflow you actually use, that's the reason to keep what we have.

It clears your bar ("switch only if much simpler and less code") cleanly. My recommendation: switch to in-app.
