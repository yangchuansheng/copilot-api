/* eslint-disable unicorn/require-post-message-target-origin */
import * as vscode from "vscode"

import type { QuestionQueue } from "./queue"
import type {
  AskUserQuestionQuestion,
  QuestionItem,
  QuestionState,
} from "./types"

export const MCP_QUESTIONS_VIEW_ID = "copilotApi.mcpQuestions"

const COPILOT_API_VIEWS_CONTAINER_COMMAND =
  "workbench.view.extension.copilotApiViews"

type WebviewItem = {
  id: string
  state: QuestionState
  createdAt: number
  deadlineAt: number
  lastError?: string
  questions: Array<AskUserQuestionQuestion>
}

type WebviewState = {
  items: Array<WebviewItem>
}

type IncomingMessage =
  | { type: "ready" }
  | { type: "activate"; id: string }
  | { type: "answer"; id: string; answers: Record<string, string> }
  | { type: "cancel"; id: string }
  | { type: "clearHistory" }

type OutgoingMessage =
  | { type: "state"; state: WebviewState }
  | { type: "activated"; id: string }
  | { type: "activationDenied"; id: string; reason: string }
  | { type: "selected"; id: string }
  | { type: "toast"; message: string }

function toWebviewItem(item: QuestionItem): WebviewItem {
  return {
    id: item.id,
    state: item.state,
    createdAt: item.createdAt,
    deadlineAt: item.deadlineAt,
    lastError: item.lastError,
    questions: item.payload.questions,
  }
}

function buildState(queue: QuestionQueue): WebviewState {
  return { items: queue.getSnapshot().map((item) => toWebviewItem(item)) }
}

function nonce(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  let value = ""
  for (let i = 0; i < 32; i += 1) {
    value += chars[Math.floor(Math.random() * chars.length)]
  }
  return value
}

function getWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): string {
  const mediaRoot = vscode.Uri.joinPath(extensionUri, "media")
  const styleUri = webview
    .asWebviewUri(vscode.Uri.joinPath(mediaRoot, "mcp-questions.css"))
    .toString()
  const scriptUri = webview
    .asWebviewUri(vscode.Uri.joinPath(mediaRoot, "mcp-questions.js"))
    .toString()
  const cspNonce = nonce()

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource}; script-src 'nonce-${cspNonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" type="text/css" href="${styleUri}">
    <title>MCP Questions</title>
  </head>
  <body>
    <div class="root">
      <div class="topbar">
        <div class="countsRow">
          <span class="pill" id="countActive">Active: 0</span>
          <span class="pill" id="countPending">Pending: 0</span>
          <span class="pill" id="countHistory">History: 0</span>
        </div>
        <div class="actionsRow">
          <button class="btn primary" id="btnAnswerNext">Answer next</button>
          <button class="btn" id="btnClearHistory">Clear history</button>
        </div>
      </div>
      <div class="main">
        <div class="list" id="list"></div>
        <div class="detail">
          <div class="toast hidden" id="toast"></div>
          <div id="detail"></div>
        </div>
      </div>
    </div>
    <script nonce="${cspNonce}" src="${scriptUri}"></script>
  </body>
</html>`
}

function createWebviewOptions(
  extensionUri: vscode.Uri,
): vscode.WebviewOptions & vscode.WebviewPanelOptions {
  const mediaRoot = vscode.Uri.joinPath(extensionUri, "media")
  return {
    enableScripts: true,
    localResourceRoots: [mediaRoot],
  }
}

function openQuestionsPanel(
  context: vscode.ExtensionContext,
  queue: QuestionQueue,
): void {
  const panel = vscode.window.createWebviewPanel(
    "copilotApi.mcpQuestionsPanel",
    "MCP Questions",
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    createWebviewOptions(context.extensionUri),
  )

  panel.webview.html = getWebviewHtml(panel.webview, context.extensionUri)

  const postState = () => {
    void panel.webview.postMessage({ type: "state", state: buildState(queue) })
  }

  const disposables = vscode.Disposable.from(
    queue.onDidChange(() => postState()),
    panel.webview.onDidReceiveMessage((message: IncomingMessage) => {
      switch (message.type) {
        case "ready": {
          postState()
          return
        }
        case "activate": {
          const item = queue.getById(message.id)
          if (!item) return

          if (item.state === "active") {
            postState()
            void panel.webview.postMessage({
              type: "activated",
              id: message.id,
            })
            return
          }

          if (item.state !== "pending") {
            void panel.webview.postMessage({
              type: "activationDenied",
              id: message.id,
              reason: "This question is no longer pending.",
            })
            return
          }

          const ok = queue.markActive(message.id)
          if (!ok) {
            const active = queue.getSnapshot().find((i) => i.state === "active")
            if (active && active.id === message.id) {
              postState()
              void panel.webview.postMessage({
                type: "activated",
                id: message.id,
              })
              return
            }

            void panel.webview.postMessage({
              type: "activationDenied",
              id: message.id,
              reason: "Another question is currently active.",
            })
            return
          }

          postState()
          void panel.webview.postMessage({ type: "activated", id: message.id })
          return
        }
        case "answer": {
          queue.answer(message.id, { answers: message.answers })
          postState()
          return
        }
        case "cancel": {
          queue.cancel(message.id, "USER_CANCELED")
          postState()
          return
        }
        case "clearHistory": {
          queue.clearHistory()
          postState()
          return
        }
        default: {
          const exhaustive: never = message
          void exhaustive
          return
        }
      }
    }),
  )

  panel.onDidDispose(() => {
    disposables.dispose()
  })
  postState()
}

class McpQuestionsWebviewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private readonly context: vscode.ExtensionContext
  private readonly queue: QuestionQueue
  private readonly disposables: Array<vscode.Disposable> = []
  private webviewView: vscode.WebviewView | undefined

  public constructor(context: vscode.ExtensionContext, queue: QuestionQueue) {
    this.context = context
    this.queue = queue
    this.disposables.push(this.queue.onDidChange(() => this.postState()))
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.webviewView = webviewView

    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, "media")
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    }

    webviewView.webview.html = getWebviewHtml(
      webviewView.webview,
      this.context.extensionUri,
    )

    this.disposables.push(
      webviewView.webview.onDidReceiveMessage((message: IncomingMessage) =>
        this.onMessage(message),
      ),
    )
  }

  public async reveal(): Promise<void> {
    await vscode.commands.executeCommand(COPILOT_API_VIEWS_CONTAINER_COMMAND)
  }

  public select(id: string): void {
    this.postMessage({ type: "selected", id })
  }

  public postState(): void {
    this.postMessage({ type: "state", state: buildState(this.queue) })
  }

  private onMessage(message: IncomingMessage): void {
    switch (message.type) {
      case "ready": {
        this.postState()
        return
      }
      case "activate": {
        const item = this.queue.getById(message.id)
        if (!item) return

        if (item.state === "active") {
          this.postState()
          this.postMessage({ type: "activated", id: message.id })
          return
        }

        if (item.state !== "pending") {
          this.postMessage({
            type: "activationDenied",
            id: message.id,
            reason: "This question is no longer pending.",
          })
          return
        }

        const ok = this.queue.markActive(message.id)
        if (!ok) {
          const currentlyActive = this.queue
            .getSnapshot()
            .find((q) => q.state === "active")
          if (currentlyActive && currentlyActive.id === message.id) {
            this.postState()
            this.postMessage({ type: "activated", id: message.id })
            return
          }

          this.postMessage({
            type: "activationDenied",
            id: message.id,
            reason: "Another question is currently active.",
          })
          return
        }

        this.postState()
        this.postMessage({ type: "activated", id: message.id })
        return
      }
      case "answer": {
        this.queue.answer(message.id, { answers: message.answers })
        this.postState()
        return
      }
      case "cancel": {
        this.queue.cancel(message.id, "USER_CANCELED")
        this.postState()
        return
      }
      case "clearHistory": {
        this.queue.clearHistory()
        this.postState()
        return
      }
      default: {
        const exhaustive: never = message
        void exhaustive
        return
      }
    }
  }

  private postMessage(message: OutgoingMessage): void {
    this.webviewView?.webview.postMessage(message)
  }

  public toast(message: string): void {
    this.postMessage({ type: "toast", message })
  }

  public dispose(): void {
    for (const d of this.disposables) d.dispose()
  }
}

export function registerMcpQuestionsView(
  context: vscode.ExtensionContext,
  queue: QuestionQueue,
): vscode.Disposable {
  const provider = new McpQuestionsWebviewProvider(context, queue)

  const registration = vscode.window.registerWebviewViewProvider(
    MCP_QUESTIONS_VIEW_ID,
    provider,
  )

  const open = async (): Promise<void> => {
    await provider.reveal()
  }

  const answerNext = async (): Promise<void> => {
    const active = queue.getSnapshot().find((i) => i.state === "active")
    if (active) {
      await provider.reveal()
      provider.select(active.id)
      return
    }

    const next = queue.getSnapshot().find((i) => i.state === "pending")
    await provider.reveal()
    if (!next) return

    const ok = queue.markActive(next.id)
    if (!ok) {
      provider.toast("Another question is currently active.")
      return
    }
    provider.postState()
    provider.select(next.id)
  }

  const openPanel = (): void => openQuestionsPanel(context, queue)

  return vscode.Disposable.from(
    registration,
    provider,
    vscode.commands.registerCommand("copilotApi.mcpQuestions.open", () =>
      open(),
    ),
    vscode.commands.registerCommand("copilotApi.mcpQuestions.answerNext", () =>
      answerNext(),
    ),
    vscode.commands.registerCommand(
      "copilotApi.mcpQuestions.clearHistory",
      () => queue.clearHistory(),
    ),
    vscode.commands.registerCommand("copilotApi.mcpQuestions.openPanel", () =>
      openPanel(),
    ),
  )
}
