import type { Server } from "srvx"

import consola, { type ConsolaReporter } from "consola"
import * as net from "node:net"
import * as vscode from "vscode"

import { createVscodeOutputReporter } from "./consola-vscode-reporter"
import { bindElectronNetFetchOnStartup } from "./electron-fetch-bind"
import { McpHttpServer } from "./mcp/http-server"
import { QuestionQueue } from "./mcp/questions/queue"
import { registerMcpQuestionsView } from "./mcp/questions/view"
import { sleep } from "./util"

type ServerStatus = "stopped" | "starting" | "running" | "stopping"

interface ExtensionConfig {
  port: number
  verbose: boolean
  accountType: "individual" | "business" | "enterprise"
  rateLimitSeconds: number | null
  rateLimitWait: boolean
  proxyEnv: boolean
  showToken: boolean
  mcpEnabled: boolean
  mcpPort: number
  mcpPath: string
  mcpAskUserTimeoutMs: number
}

let outputChannel: vscode.OutputChannel | undefined
let statusItem: vscode.StatusBarItem | undefined

let status: ServerStatus = "stopped"
let localServer: Server | undefined
let endpoint: string | undefined
let consolaReporter: ConsolaReporter | undefined
let lifecycleVersion = 0

let mcpHttpServer: McpHttpServer | undefined
let questionQueue: QuestionQueue | undefined
let mcpWiringDisposable: vscode.Disposable | undefined
let extensionContext: vscode.ExtensionContext | undefined

function stopMcpServer(reason: string): Promise<void> {
  questionQueue?.failAll(reason)
  return mcpHttpServer?.stop() ?? Promise.resolve()
}

async function startMcpServerAfterCopilotStarted(
  config: ExtensionConfig,
): Promise<void> {
  if (!config.mcpEnabled) return
  if (!extensionContext) return
  if (getServerStatus() !== "running") return

  if (!isValidPort(config.mcpPort)) {
    void vscode.window.showErrorMessage(
      `Invalid MCP port: ${config.mcpPort} (must be 1-65535).`,
    )
    return
  }

  if (!isValidMcpPath(config.mcpPath)) {
    void vscode.window.showErrorMessage(
      `Invalid MCP path: ${config.mcpPath} (must start with '/' and contain no spaces).`,
    )
    return
  }

  if (!questionQueue) {
    questionQueue = new QuestionQueue(config.mcpAskUserTimeoutMs)
    extensionContext.subscriptions.push(questionQueue)
  } else {
    questionQueue.setTimeoutMs(config.mcpAskUserTimeoutMs)
  }

  if (!mcpWiringDisposable) {
    mcpWiringDisposable = registerMcpQuestionsView(
      extensionContext,
      questionQueue,
    )
    extensionContext.subscriptions.push(mcpWiringDisposable)
  }

  if (!mcpHttpServer) {
    mcpHttpServer = new McpHttpServer(getOutputChannel(), questionQueue, {
      port: config.mcpPort,
      path: config.mcpPath,
    })
    extensionContext.subscriptions.push(mcpHttpServer)
  }

  if (
    !mcpHttpServer.getEndpoint()
    && !(await isPortAvailable(config.mcpPort))
  ) {
    void vscode.window.showErrorMessage(
      `MCP port ${config.mcpPort} is already in use. Change "copilotApi.mcpPort" in settings.`,
    )
    return
  }

  try {
    await mcpHttpServer.start()
  } catch (error) {
    const { message, stack } = serializeError(error)
    getOutputChannel().appendLine(`[mcp] Failed to start: ${message}`)
    if (stack) getOutputChannel().appendLine(stack)
    void vscode.window.showErrorMessage(`MCP failed: ${message}`)
  }
}

function getServerStatus(): ServerStatus {
  return status
}

function setServerStopped(): void {
  status = "stopped"
  endpoint = undefined
  setStatus("Copilot API: Stopped", "copilotApi.start")
}

function setServerStarting(): void {
  status = "starting"
  setStatus("Copilot API: Starting...")
}

function setServerRunning(port: number): void {
  status = "running"
  setStatus(`Copilot API: Running (${port})`, "copilotApi.stop")
}

function setServerStopping(): void {
  status = "stopping"
  setStatus("Copilot API: Stopping...")
}

function getOutputChannel(): vscode.OutputChannel {
  outputChannel ??= vscode.window.createOutputChannel("Copilot API")
  return outputChannel
}

function setStatus(text: string, command?: string) {
  statusItem ??= vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  )
  statusItem.text = text
  statusItem.command = command
  statusItem.show()
}

function getConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration("copilotApi")

  const port = cfg.get<number>("port", 4141)
  const verbose = cfg.get<boolean>("verbose", false)
  const accountType = cfg.get<ExtensionConfig["accountType"]>(
    "accountType",
    "individual",
  )
  const rateLimitSeconds = cfg.get<number | null>("rateLimitSeconds", null)
  const rateLimitWait = cfg.get<boolean>("rateLimitWait", false)
  const proxyEnv = cfg.get<boolean>("proxyEnv", false)
  const showToken = cfg.get<boolean>("showToken", false)

  const mcpEnabled = cfg.get<boolean>("mcpEnabled", true)
  const mcpPort = cfg.get<number>("mcpPort", 4142)
  const mcpPath = cfg.get<string>("mcpPath", "/mcp")
  const mcpAskUserTimeoutMs = cfg.get<number>("mcpAskUserTimeoutMs", 600_000)

  return {
    port,
    verbose,
    accountType,
    rateLimitSeconds,
    rateLimitWait,
    proxyEnv,
    showToken,
    mcpEnabled,
    mcpPort,
    mcpPath,
    mcpAskUserTimeoutMs,
  }
}

async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = net.createServer()
    server.unref()

    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        resolve(false)
        return
      }
      resolve(false)
    })

    server.listen({ host: "127.0.0.1", port }, () => {
      server.close(() => {
        resolve(true)
      })
    })
  })
}

function cleanupLocalServer() {
  localServer = undefined
}

function cleanupConsolaReporter() {
  if (!consolaReporter) return
  consola.removeReporter(consolaReporter)
  consolaReporter = undefined
}

function serializeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack }
  }
  return { message: String(error) }
}

async function stopServer(): Promise<void> {
  const output = getOutputChannel()
  lifecycleVersion += 1

  const currentLocalServer = localServer

  if (!currentLocalServer) {
    await stopMcpServer("MCP_SERVER_STOPPED")
    cleanupConsolaReporter()
    setServerStopped()
    return
  }

  if (getServerStatus() === "stopping") return
  setServerStopping()

  try {
    await stopMcpServer("MCP_SERVER_STOPPED")
    await currentLocalServer.close(true)
  } catch (error) {
    output.appendLine(`[stop] Failed to close server: ${String(error)}`)
  } finally {
    if (localServer === currentLocalServer) cleanupLocalServer()
    cleanupConsolaReporter()
    setServerStopped()
  }
}

async function startServer(): Promise<void> {
  const output = getOutputChannel()
  output.show(true)

  const currentStatus = getServerStatus()
  if (currentStatus === "starting" || currentStatus === "running") {
    void vscode.window.showInformationMessage(
      "Copilot API server is already running.",
    )
    return
  }

  const config = getConfig()
  if (!isValidPort(config.port)) {
    void vscode.window.showErrorMessage(
      `Invalid port: ${config.port} (must be 1-65535).`,
    )
    return
  }

  if (!config.proxyEnv) {
    await bindElectronNetFetchOnStartup(output)
  }

  if (!(await isPortAvailable(config.port))) {
    void vscode.window.showErrorMessage(
      `Port ${config.port} is already in use. Change "copilotApi.port" in settings.`,
    )
    return
  }

  setServerStarting()
  const currentLifecycleVersion = (lifecycleVersion += 1)

  void showStartingHintAfterDelay()
  try {
    consolaReporter = createVscodeOutputReporter(output)
    consola.addReporter(consolaReporter)

    process.env.HOST = "127.0.0.1"
    process.env.NODE_ENV ??= "production"

    const { startServer: startCopilotServer } = await import("../../src/start")
    const currentServer = await startCopilotServer({
      port: config.port,
      verbose: config.verbose,
      accountType: config.accountType,
      manual: false,
      rateLimit: config.rateLimitSeconds ?? undefined,
      rateLimitWait: config.rateLimitWait,
      githubToken: undefined,
      claudeCode: false,
      showToken: config.showToken,
      proxyEnv: config.proxyEnv,
    })

    if (currentLifecycleVersion !== lifecycleVersion) {
      await currentServer.close(true)
      cleanupConsolaReporter()
      return
    }

    localServer = currentServer
    endpoint = `http://localhost:${config.port}`
    setServerRunning(config.port)
    output.appendLine(`[server] Ready: ${endpoint}`)

    await startMcpServerAfterCopilotStarted(config)
  } catch (error) {
    const { message, stack } = serializeError(error)
    output.appendLine(`[server] Error: ${message}`)
    if (stack) output.appendLine(stack)
    cleanupConsolaReporter()
    cleanupLocalServer()
    setServerStopped()
    void vscode.window.showErrorMessage(`Copilot API failed: ${message}`)
  }
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535
}

function isValidMcpPath(pathname: string): boolean {
  return pathname.startsWith("/") && !pathname.includes(" ")
}

async function showStartingHintAfterDelay(): Promise<void> {
  await sleep(10_000)

  if (getServerStatus() === "starting") {
    setStatus("Copilot API: Starting... (see Output)")
  }
}

async function restartServer(): Promise<void> {
  await stopServer()
  await startServer()
}

async function copyEndpoint(): Promise<void> {
  if (!endpoint) {
    void vscode.window.showWarningMessage("Copilot API server is not running.")
    return
  }
  await vscode.env.clipboard.writeText(endpoint)
  void vscode.window.showInformationMessage(`Copied endpoint: ${endpoint}`)
}

async function openUsageViewer(): Promise<void> {
  if (!endpoint) {
    void vscode.window.showWarningMessage("Copilot API server is not running.")
    return
  }

  const usageUrl = `https://ericc-ch.github.io/copilot-api?endpoint=${encodeURIComponent(
    `${endpoint}/usage`,
  )}`

  await vscode.env.openExternal(vscode.Uri.parse(usageUrl))
}

async function copyMcpEndpoint(): Promise<void> {
  const endpoint = mcpHttpServer?.getEndpoint()
  if (!endpoint) {
    void vscode.window.showWarningMessage("MCP server is not running.")
    return
  }
  await vscode.env.clipboard.writeText(endpoint)
  void vscode.window.showInformationMessage(`Copied MCP endpoint: ${endpoint}`)
}

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context
  context.subscriptions.push(getOutputChannel())

  setStatus("Copilot API: Stopped", "copilotApi.start")

  context.subscriptions.push(
    vscode.commands.registerCommand("copilotApi.start", () => startServer()),
    vscode.commands.registerCommand("copilotApi.stop", () => stopServer()),
    vscode.commands.registerCommand("copilotApi.restart", () =>
      restartServer(),
    ),
    vscode.commands.registerCommand("copilotApi.copyEndpoint", () =>
      copyEndpoint(),
    ),
    vscode.commands.registerCommand("copilotApi.openUsageViewer", () =>
      openUsageViewer(),
    ),
    vscode.commands.registerCommand("copilotApi.copyMcpEndpoint", () =>
      copyMcpEndpoint(),
    ),
  )

  const config = getConfig()
  if (config.mcpEnabled) {
    if (!isValidPort(config.mcpPort)) {
      void vscode.window.showErrorMessage(
        `Invalid MCP port: ${config.mcpPort} (must be 1-65535).`,
      )
    } else if (!isValidMcpPath(config.mcpPath)) {
      void vscode.window.showErrorMessage(
        `Invalid MCP path: ${config.mcpPath} (must start with '/' and contain no spaces).`,
      )
    } else {
      questionQueue = new QuestionQueue(config.mcpAskUserTimeoutMs)
      mcpHttpServer = new McpHttpServer(getOutputChannel(), questionQueue, {
        port: config.mcpPort,
        path: config.mcpPath,
      })
      mcpWiringDisposable = registerMcpQuestionsView(context, questionQueue)

      context.subscriptions.push(
        questionQueue,
        mcpWiringDisposable,
        mcpHttpServer,
      )
    }
  }
}

export async function deactivate() {
  await stopMcpServer("EXTENSION_UNAVAILABLE")
  await stopServer()
  outputChannel?.dispose()
  statusItem?.dispose()
}
