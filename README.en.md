# dsh-memory-file

[简体中文（完整版）](README.md) · English (abridged)

> This is an **abridged English version**. The [Chinese README](README.md) is the source of truth;
> details that change often (design notes, changelog, screenshots) live there.

File-backed long-term memory for DeepSeek Harness: injects your own Markdown memory file at each session start, and adds tools to write it, queue uncertain lines for review, undo a bad write, and audit what it actually read. Reads no conversations by default, never opens a network connection, never deletes files.

[![version](https://img.shields.io/badge/version-1.3.0-blue)](https://github.com/wojiao42/dsh-memory-file/releases)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

## What it does

- Injects your Markdown memory file once per session (the first `pre-step`), so it is not re-sent on every turn.
- 7 agent tools: `memory_add`, `memory_recall`, `memory_list`, `memory_undo`, `memory_pending`, `memory_scan`, `memory_status`.
- Every write is backed up in full first; `memory_undo` restores the previous file; low-confidence lines go to `MEMORY.pending.md` instead of the memory file.
- Optional `autoScan` (default **off**): reads local session logs only to surface your own recent lines, so the agent can file them.
- `memory_status` reports `DSH_HOME` and session counts, so a moved harness home does not look like "all history is gone".

## Quick start

**GUI (recommended on desktop):** Settings (Ctrl+,) → Plugin market → Custom install → `github:wojiao42/dsh-memory-file`, then restart DSH.

> The desktop profile is app-managed: running `dsh plugin --profile desktop add` may be rejected; if it is, use the GUI step above.

**Command line (Web profile):**

```bash
dsh plugin --profile web add github:wojiao42/dsh-memory-file
```

Refresh the page afterwards.

**Local source:** Plugin market → Custom install → the absolute path on your machine; restart DSH after code changes (the install is a copy, not a link).

## Key limits

- Reads no `messages`: the only subscription is `agent/pre-step`, whose arguments never destructure them.
- Session logs are not read unless `autoScan: true`; that scan is read-only, capped at 8MB per file and 32MB per run.
- No network calls, no `child_process`, no `rm` / `rename` / `chmod`.
- Writes only to the memory file, its `backup/`, `MEMORY.pending.md` and `.autoscan.json`; all paths are derived, never passed in.
- `memory_recall` is literal keyword search, not semantic search. `memory_add` does not deduplicate. `memory_undo` rolls back the whole file, not one line.

## Compatibility

- Install sources: npm / github / local path.
- Host-side plugin for DSH Desktop and DSH Web; no client UI, so no `dsh.client` (enabled via `dsh.bundle.patch`).
- Dependencies: only `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-tools`, both provided by the host. No third-party packages.
- No `engines` or `peerDependencies` declared. Node must provide `zlib.zstdDecompressSync` (Node 22.15 / 23.8+).
- Self-test, both offline: `node smoke.mjs` (51 assertions) and `node tools/publish-test.mjs` (25 assertions).

## License

MIT. See [LICENSE](LICENSE).
