import { randomUUID } from "node:crypto"
import * as vscode from "vscode"

import type {
  AskUserQuestionParams,
  AskUserQuestionResult,
  QuestionItem,
} from "./types"

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export interface EnqueueResult {
  id: string
  promise: Promise<AskUserQuestionResult>
}

export class QuestionQueue implements vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>()
  public readonly onDidChange = this.onDidChangeEmitter.event

  private readonly onDidEnqueueEmitter = new vscode.EventEmitter<QuestionItem>()
  public readonly onDidEnqueue = this.onDidEnqueueEmitter.event

  private readonly items: Array<QuestionItem> = []
  private readonly deferredById = new Map<
    string,
    Deferred<AskUserQuestionResult>
  >()
  private readonly timeoutById = new Map<string, NodeJS.Timeout>()

  private timeoutMs: number

  public constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs
  }

  public setTimeoutMs(timeoutMs: number): void {
    this.timeoutMs = timeoutMs
  }

  public enqueue(payload: AskUserQuestionParams): EnqueueResult {
    const id = randomUUID()
    const createdAt = Date.now()
    const deadlineAt = createdAt + this.timeoutMs

    const item: QuestionItem = {
      id,
      createdAt,
      deadlineAt,
      state: "pending",
      payload,
    }

    const deferred = createDeferred<AskUserQuestionResult>()
    this.items.push(item)
    this.deferredById.set(id, deferred)

    const timeout = setTimeout(() => {
      this.expire(id)
    }, this.timeoutMs)
    timeout.unref()
    this.timeoutById.set(id, timeout)

    this.onDidChangeEmitter.fire()
    this.onDidEnqueueEmitter.fire(item)

    return { id, promise: deferred.promise }
  }

  public getSnapshot(): ReadonlyArray<QuestionItem> {
    return this.items.slice()
  }

  public clearHistory(): void {
    const before = this.items.length
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      const item = this.items[index]
      if (
        item.state === "answered"
        || item.state === "canceled"
        || item.state === "expired"
        || item.state === "failed"
      ) {
        this.items.splice(index, 1)
      }
    }
    if (this.items.length !== before) this.onDidChangeEmitter.fire()
  }

  public getById(id: string): QuestionItem | undefined {
    return this.items.find((i) => i.id === id)
  }

  public markActive(id: string): boolean {
    const item = this.getById(id)
    if (!item || item.state !== "pending") return false
    const active = this.items.find((i) => i.state === "active")
    if (active) return false
    item.state = "active"
    this.onDidChangeEmitter.fire()
    return true
  }

  public answer(id: string, result: AskUserQuestionResult): boolean {
    const item = this.getById(id)
    if (!item) return false
    if (item.state !== "pending" && item.state !== "active") return false

    item.state = "answered"
    item.result = result

    this.clearTimeout(id)
    const deferred = this.deferredById.get(id)
    deferred?.resolve(result)
    this.deferredById.delete(id)

    this.onDidChangeEmitter.fire()
    return true
  }

  public cancel(id: string, reason: string): boolean {
    const item = this.getById(id)
    if (!item) return false
    if (item.state !== "pending" && item.state !== "active") return false

    item.state = "canceled"
    item.lastError = reason

    this.clearTimeout(id)
    const deferred = this.deferredById.get(id)
    deferred?.reject(new Error(reason))
    this.deferredById.delete(id)

    this.onDidChangeEmitter.fire()
    return true
  }

  public fail(id: string, reason: string): boolean {
    const item = this.getById(id)
    if (!item) return false
    if (item.state !== "pending" && item.state !== "active") return false

    item.state = "failed"
    item.lastError = reason

    this.clearTimeout(id)
    const deferred = this.deferredById.get(id)
    deferred?.reject(new Error(reason))
    this.deferredById.delete(id)

    this.onDidChangeEmitter.fire()
    return true
  }

  private expire(id: string): void {
    const item = this.getById(id)
    if (!item) return
    if (item.state !== "pending" && item.state !== "active") return

    item.state = "expired"
    item.lastError = "USER_INPUT_TIMEOUT"

    this.clearTimeout(id)
    const deferred = this.deferredById.get(id)
    deferred?.reject(new Error("USER_INPUT_TIMEOUT"))
    this.deferredById.delete(id)

    this.onDidChangeEmitter.fire()
  }

  private clearTimeout(id: string): void {
    const timeout = this.timeoutById.get(id)
    if (timeout) clearTimeout(timeout)
    this.timeoutById.delete(id)
  }

  public failAll(reason: string): void {
    for (const item of this.items) {
      if (item.state === "pending" || item.state === "active") {
        item.state = "failed"
        item.lastError = reason
        this.clearTimeout(item.id)
        const deferred = this.deferredById.get(item.id)
        deferred?.reject(new Error(reason))
        this.deferredById.delete(item.id)
      }
    }
    this.onDidChangeEmitter.fire()
  }

  public dispose(): void {
    this.failAll("EXTENSION_UNAVAILABLE")
    this.onDidChangeEmitter.dispose()
    this.onDidEnqueueEmitter.dispose()
  }
}
