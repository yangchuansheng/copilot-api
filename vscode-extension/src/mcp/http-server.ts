import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import * as http from "node:http"
import * as vscode from "vscode"

import type { QuestionQueue } from "./questions/queue"

import { registerAskUserQuestionTool } from "./tools/ask-user-question"

export interface McpHttpServerConfig {
  port: number
  path: string
}

async function readJsonBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  const chunks: Array<Buffer> = []
  let total = 0

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    total += buf.length
    if (total > maxBytes) {
      throw new Error("REQUEST_TOO_LARGE")
    }
    chunks.push(buf)
  }

  const text = Buffer.concat(chunks).toString("utf8")
  if (text.trim().length === 0) return undefined
  return JSON.parse(text) as unknown
}

function writeJson(
  res: http.ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  const text = JSON.stringify(payload)
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  })
  res.end(text)
}

function createServer(queue: QuestionQueue): McpServer {
  const server = new McpServer(
    { name: "copilot-api-vscode", version: "0.1.0" },
    { capabilities: { logging: {} } },
  )
  registerAskUserQuestionTool(server, queue)
  return server
}

export class McpHttpServer implements vscode.Disposable {
  private server: http.Server | undefined
  private endpoint: string | undefined

  private readonly output: vscode.OutputChannel
  private readonly queue: QuestionQueue
  private readonly config: McpHttpServerConfig

  public constructor(
    output: vscode.OutputChannel,
    queue: QuestionQueue,
    config: McpHttpServerConfig,
  ) {
    this.output = output
    this.queue = queue
    this.config = config
  }

  public getEndpoint(): string | undefined {
    return this.endpoint
  }

  public async start(): Promise<void> {
    if (this.server) return

    const { port, path } = this.config
    const httpServer = http.createServer(async (req, res) => {
      const url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`,
      )
      if (url.pathname !== path) {
        writeJson(res, 404, { error: "Not Found" })
        return
      }

      if (req.method !== "POST") {
        res.setHeader("Allow", "POST")
        writeJson(res, 405, { error: "Method Not Allowed" })
        return
      }

      let parsedBody: unknown
      try {
        parsedBody = await readJsonBody(req, 256 * 1024)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message === "REQUEST_TOO_LARGE") {
          writeJson(res, 413, { error: "Request Too Large" })
          return
        }
        writeJson(res, 400, { error: "Invalid JSON" })
        return
      }

      const mcpServer = createServer(this.queue)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })

      res.on("close", () => {
        void transport.close()
        void mcpServer.close()
      })

      try {
        await mcpServer.connect(transport)
        type TransportReq = Parameters<
          StreamableHTTPServerTransport["handleRequest"]
        >[0]
        await transport.handleRequest(req as TransportReq, res, parsedBody)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.output.appendLine(`[mcp] Error handling request: ${message}`)
        if (!res.headersSent)
          writeJson(res, 500, { error: "Internal Server Error" })
      }
    })

    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject)
      httpServer.listen({ host: "127.0.0.1", port }, () => resolve())
    })

    this.server = httpServer
    this.endpoint = `http://localhost:${port}${path}`
    this.output.appendLine(`[mcp] Ready: ${this.endpoint}`)
  }

  public async stop(): Promise<void> {
    if (!this.server) return
    const current = this.server
    this.server = undefined
    this.endpoint = undefined

    await new Promise<void>((resolve) => {
      current.close(() => resolve())
    })
  }

  public dispose(): void {
    void this.stop()
  }
}
