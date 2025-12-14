# AGENTS.md (vscode-extension)

This directory contains the VS Code extension that embeds `copilot-api` and also hosts a local MCP server + UI for `AskUserQuestion`.

## Build, Lint, and Test Commands

- **Install:** `bun install`
- **Build:** `bun run build`
- **Build (debug):** `bun run build:debug`
- **Typecheck:** `bunx tsc -p tsconfig.json`
- **Package VSIX:** `bun run package`
- **Lint (repo root):** from `copilot-api` run `bun run lint`

## Notes

- The MCP web UI assets live in `vscode-extension/media/` and are loaded by `src/mcp/questions/view.ts`.
- To debug the extension, build with `bun run build:debug` and then run the Extension Host (`F5`).


