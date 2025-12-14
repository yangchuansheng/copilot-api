export interface AskUserQuestionOption {
  label: string
  description: string
}

export interface AskUserQuestionQuestion {
  header: string
  question: string
  options: Array<AskUserQuestionOption>
  multiSelect: boolean
}

export interface AskUserQuestionParams {
  questions: Array<AskUserQuestionQuestion>
}

export interface AskUserQuestionResult {
  answers: Record<string, string>
}

export type QuestionState =
  | "pending"
  | "active"
  | "answered"
  | "canceled"
  | "expired"
  | "failed"

export interface QuestionItem {
  id: string
  createdAt: number
  deadlineAt: number
  state: QuestionState
  payload: AskUserQuestionParams
  lastError?: string
  result?: AskUserQuestionResult
}
