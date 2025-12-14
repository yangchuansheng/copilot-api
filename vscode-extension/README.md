# Copilot API (Embedded)

Runs `copilot-api` inside VS Code as an extension, so you can start/stop the local server without installing Bun separately.

## Commands

- `Copilot API: Start Server`
- `Copilot API: Stop Server`
- `Copilot API: Restart Server`
- `Copilot API: Copy Endpoint`
- `Copilot API: Copy MCP Endpoint`
- `Copilot API: Open Usage Viewer`
- `Copilot API: Open MCP Questions`
- `Copilot API: Answer Next MCP Question`
- `Copilot API: Clear MCP Question History`
- `Copilot API: Open MCP Questions (Editor)`

## Settings

- `copilotApi.port` (number, default `4141`): Port to listen on (localhost only)
- `copilotApi.verbose` (boolean): Verbose logging
- `copilotApi.accountType` (`individual` | `business` | `enterprise`)
- `copilotApi.rateLimitSeconds` (number | null): Minimum seconds between requests
- `copilotApi.rateLimitWait` (boolean): Wait instead of error when rate limit is hit
- `copilotApi.proxyEnv` (boolean): Initialize proxy from `HTTP(S)_PROXY`, etc
- `copilotApi.showToken` (boolean): Log tokens (debug only)
- `copilotApi.mcpEnabled` (boolean, default `true`): Enable the embedded MCP server (localhost only)
- `copilotApi.mcpPort` (number, default `4142`): MCP server port (localhost only)
- `copilotApi.mcpPath` (string, default `/mcp`): MCP HTTP path (Streamable HTTP endpoint)
- `copilotApi.mcpAskUserTimeoutMs` (number, default `600000`): AskUserQuestion timeout (ms)

## Usage

1. Run `Copilot API: Start Server`
2. Use the endpoint (e.g. `http://localhost:4141`) with your client
3. Use `Copilot API: Open Usage Viewer` to open the usage dashboard

## MCP: AskUserQuestion

This extension also starts a local MCP server (Streamable HTTP, JSON response mode) and exposes a tool:

- Tool name: `AskUserQuestion`
- Endpoint: `http://localhost:4142/mcp` (or run `Copilot API: Copy MCP Endpoint`)

The MCP server starts **after** you run `Copilot API: Start Server` (and is stopped when you stop the Copilot API server).

When a client calls `AskUserQuestion`, the request is queued and shown in the **MCP Questions** web UI inside VS Code. The tool call blocks until you submit the answers (or 10 minutes pass).

Tips:

- If the sidebar is too narrow, use `Copilot API: Open MCP Questions (Editor)` to open the same UI in an editor tab.
- `answers` keys are the question `header` values and must be unique per call.

## Development

- Build: `bun run build`
- Debug (Extension Host): `bun run build:debug`, then press `F5` (uses `.vscode/launch.json`)
- Package VSIX: `bun run package`
