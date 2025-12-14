import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import * as z from "zod/v4"

import type { QuestionQueue } from "../questions/queue"
import type {
  AskUserQuestionParams,
  AskUserQuestionResult,
} from "../questions/types"

const description =
  'Use this tool when you need to ask the user questions during execution. This allows you to:\n1. Gather user preferences or requirements\n2. Clarify ambiguous instructions\n3. Get decisions on implementation choices as you work\n4. Offer choices to the user about what direction to take.\n\nUsage notes:\n- Users will always be able to select "Other" to provide custom text input\n- Use multiSelect: true to allow multiple answers to be selected for a question\n- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label. Options must not include an Other choice (it is added automatically).\n'

const optionSchema = z
  .object({
    label: z.string().min(1).describe("The display text for the option."),
    description: z.string().min(1).describe("Explanation for this option."),
  })
  .strict()

const questionSchema = z
  .object({
    header: z
      .string()
      .min(1)
      .max(12)
      .describe("Very short label displayed as a chip/tag (max 12 chars)."),
    question: z
      .string()
      .min(1)
      .describe("The complete question to ask the user."),
    multiSelect: z.boolean(),
    options: z.array(optionSchema).min(2).max(4),
  })
  .strict()

const inputShape = {
  questions: z.array(questionSchema).min(1).max(3),
}

const outputShape = {
  answers: z.record(z.string(), z.string()),
}

function textBlock(text: string) {
  return { type: "text" as const, text }
}

function invalidArguments(message: string, details?: unknown) {
  return {
    isError: true,
    content: [textBlock(message)],
    structuredContent:
      details ? { code: "INVALID_ARGUMENTS", details } : undefined,
  }
}

function toolError(code: string, message: string) {
  return {
    isError: true,
    content: [textBlock(message)],
    structuredContent: { code, message },
  }
}

function findDuplicateHeaders(headers: Array<string>): Array<string> {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const header of headers) {
    if (seen.has(header)) duplicates.add(header)
    seen.add(header)
  }
  return Array.from(duplicates)
}

function validateBusinessRules(params: AskUserQuestionParams) {
  const headers = params.questions.map((q) => q.header)
  const duplicates = findDuplicateHeaders(headers)
  if (duplicates.length > 0) {
    return invalidArguments("Duplicate question headers are not allowed.", {
      duplicates,
    })
  }

  for (const question of params.questions) {
    for (const option of question.options) {
      if (option.label.trim().toLowerCase() === "other") {
        return invalidArguments(
          "Options must not include an 'Other' choice (it is added automatically).",
          { header: question.header, option: option.label },
        )
      }
    }
  }

  return null
}

export function registerAskUserQuestionTool(
  server: McpServer,
  queue: QuestionQueue,
): void {
  server.registerTool(
    "AskUserQuestion",
    {
      description,
      inputSchema: inputShape,
      outputSchema: outputShape,
    },
    async ({ questions }, extra) => {
      const params: AskUserQuestionParams = { questions }
      const invalid = validateBusinessRules(params)
      if (invalid) return invalid

      const { id, promise } = queue.enqueue(params)

      const abortListener = () => {
        queue.cancel(id, "CLIENT_DISCONNECTED")
      }

      if (extra.signal.aborted) abortListener()
      else extra.signal.addEventListener("abort", abortListener, { once: true })

      try {
        const result = await promise
        const ok: AskUserQuestionResult = result
        return {
          content: [textBlock("User answered.")],
          structuredContent: ok as unknown as Record<string, unknown>,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        switch (message) {
          case "USER_CANCELED": {
            return toolError("USER_CANCELED", "User canceled the question.")
          }
          case "USER_INPUT_TIMEOUT": {
            return toolError(
              "USER_INPUT_TIMEOUT",
              "Timed out waiting for user input.",
            )
          }
          case "CLIENT_DISCONNECTED": {
            return toolError(
              "CLIENT_DISCONNECTED",
              "Client disconnected before the user answered.",
            )
          }
          case "EXTENSION_UNAVAILABLE": {
            return toolError(
              "EXTENSION_UNAVAILABLE",
              "Extension became unavailable.",
            )
          }
          default: {
            return toolError("INTERNAL_ERROR", message)
          }
        }
      } finally {
        extra.signal.removeEventListener("abort", abortListener)
      }
    },
  )
}
