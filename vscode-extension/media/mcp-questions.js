/* global acquireVsCodeApi */

const vscode = acquireVsCodeApi()

/** @type {{ items: any[], selectedId?: string }} */
const model = { items: [], selectedId: undefined }

const elList = document.querySelector("#list")
const elDetail = document.querySelector("#detail")
const elToast = document.querySelector("#toast")
const elCountActive = document.querySelector("#countActive")
const elCountPending = document.querySelector("#countPending")
const elCountHistory = document.querySelector("#countHistory")
const btnAnswerNext = document.querySelector("#btnAnswerNext")
const btnClearHistory = document.querySelector("#btnClearHistory")

function assertElement(el, name) {
  if (!el) throw new Error(`Missing element: ${name}`)
  return el
}

assertElement(elList, "#list")
assertElement(elDetail, "#detail")
assertElement(elToast, "#toast")
assertElement(elCountActive, "#countActive")
assertElement(elCountPending, "#countPending")
assertElement(elCountHistory, "#countHistory")
assertElement(btnAnswerNext, "#btnAnswerNext")
assertElement(btnClearHistory, "#btnClearHistory")

function escapeHtml(input) {
  return String(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")
}

function setToast(text) {
  if (!text) {
    elToast.textContent = ""
    elToast.classList.add("hidden")
    return
  }
  elToast.textContent = String(text)
  elToast.classList.remove("hidden")
  window.setTimeout(() => setToast(""), 4500)
}

function groupItems(items) {
  const active = items.filter((i) => i.state === "active")
  const pending = items.filter((i) => i.state === "pending")
  const history = items.filter((i) =>
    ["answered", "canceled", "expired", "failed"].includes(i.state),
  )
  return { active, pending, history }
}

function formatTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h`
}

function stateBadge(state) {
  const map = {
    active: "Active",
    pending: "Pending",
    answered: "Answered",
    canceled: "Canceled",
    expired: "Expired",
    failed: "Failed",
  }
  return map[state] || state
}

function summarizeHeaders(item) {
  const headers = item.questions.map((q) => q.header).join(", ")
  return headers.length <= 80 ? headers : headers.slice(0, 77) + "..."
}

function renderList() {
  const { active, pending, history } = groupItems(model.items)

  elCountActive.textContent = `Active: ${active.length}`
  elCountPending.textContent = `Pending: ${pending.length}`
  elCountHistory.textContent = `History: ${history.length}`

  btnAnswerNext.disabled = pending.length === 0 && active.length === 0
  btnClearHistory.disabled = history.length === 0

  /** @type {string[]} */
  const parts = []

  const renderGroup = (title, items) => {
    parts.push(`<div class="group">${title} (${items.length})</div>`)
    if (items.length === 0) {
      parts.push('<div class="item item-empty">No items</div>')
      return
    }
    for (const item of items) {
      const selected = model.selectedId === item.id ? " selected" : ""
      const now = Date.now()
      const remaining = item.deadlineAt ? item.deadlineAt - now : 0
      const meta =
        item.state === "pending" || item.state === "active"
          ? `~${formatTime(remaining)} left`
          : ""
      parts.push(
        `<div class="item${selected}" data-id="${item.id}">` +
          `<div class="row">` +
          `<div class="title">AskUserQuestion (${item.questions.length})</div>` +
          `<div class="state">${escapeHtml(stateBadge(item.state))}</div>` +
          `</div>` +
          `<div class="row" style="margin-top:2px;">` +
          `<div class="headers">${escapeHtml(summarizeHeaders(item))}</div>` +
          `<div class="meta">${escapeHtml(meta)}</div>` +
          `</div>` +
          `</div>`,
      )
    }
  }

  renderGroup("Active", active)
  renderGroup("Pending", pending)
  renderGroup("History", history)

  elList.innerHTML = parts.join("")
}

function renderEmptyDetail() {
  elDetail.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">👋</div>
      <div class="empty-title">No Question Selected</div>
      <div class="empty-desc">Select a question from the list to view details and provide answers.</div>
    </div>`
}

function renderDetailForItem(item) {
  const isAnswerable = item.state === "pending" || item.state === "active"

  /** @type {string[]} */
  const headerParts = []
  const now = Date.now()
  const remaining = item.deadlineAt ? item.deadlineAt - now : 0
  const timing =
    item.state === "pending" || item.state === "active"
      ? `Timeout in ~${formatTime(remaining)}`
      : ""

  headerParts.push('<div class="card">')
  headerParts.push('<div class="cardHeader">')
  headerParts.push('<div class="title">AskUserQuestion</div>')
  headerParts.push(
    `<div class="state">${escapeHtml(stateBadge(item.state))}</div>`,
  )
  headerParts.push("</div>")
  headerParts.push(`<div class="muted">${escapeHtml(timing)}</div>`)

  if (item.lastError) {
    headerParts.push(`<div class="error">${escapeHtml(item.lastError)}</div>`)
  }

  if (!isAnswerable) {
    headerParts.push('<div class="divider"></div>')
    headerParts.push('<div class="muted">This question is not answerable.</div>')
    headerParts.push("</div>")
    elDetail.innerHTML = headerParts.join("")
    return
  }

  if (item.state === "pending") {
    headerParts.push('<div class="divider"></div>')
    headerParts.push(
      '<div class="muted">This question is pending. Click “Start answering” to lock it as active.</div>',
    )
    headerParts.push('<div class="actions">')
    headerParts.push(
      '<button class="btn primary" type="button" id="btnStart">Start answering</button>',
    )
    headerParts.push(
      '<button class="btn" type="button" id="btnCancel">Cancel</button>',
    )
    headerParts.push("</div>")
    headerParts.push("</div>")
    elDetail.innerHTML = headerParts.join("")

    const btnStart = document.querySelector("#btnStart")
    const btnCancel = document.querySelector("#btnCancel")
    btnStart.addEventListener("click", () => {
      vscode.postMessage({ type: "activate", id: item.id })
    })
    btnCancel.addEventListener("click", () => {
      vscode.postMessage({ type: "cancel", id: item.id })
    })
    return
  }

  headerParts.push('<div class="divider"></div>')
  headerParts.push("</div>")

  /** @type {string[]} */
  const formParts = []
  formParts.push('<form id="answerForm">')
  for (let qi = 0; qi < item.questions.length; qi += 1) {
    const q = item.questions[qi]
    const name = `q_${qi}`
    const inputType = q.multiSelect ? "checkbox" : "radio"

    formParts.push(
      `<fieldset data-header="${escapeHtml(q.header)}" data-multi="${
        q.multiSelect ? "1" : "0"
      }">`,
    )
    formParts.push(`<legend>${escapeHtml(q.header)}</legend>`)
    formParts.push(`<p class="qtext">${escapeHtml(q.question)}</p>`)

    for (let oi = 0; oi < q.options.length; oi += 1) {
      const opt = q.options[oi]
      formParts.push('<div class="opt">')
      formParts.push(
        `<input type="${inputType}" name="${name}" value="${escapeHtml(
          opt.label,
        )}" />`,
      )
      formParts.push("<div>")
      formParts.push(`<div class="optlabel">${escapeHtml(opt.label)}</div>`)
      formParts.push(
        `<div class="optdesc">${escapeHtml(opt.description)}</div>`,
      )
      formParts.push("</div>")
      formParts.push("</div>")
    }

    formParts.push('<div class="opt">')
    formParts.push(
      `<input type="${inputType}" name="${name}" value="__other__" />`,
    )
    formParts.push("<div>")
    formParts.push('<div class="optlabel">Other</div>')
    formParts.push('<div class="optdesc">Provide custom text input</div>')
    formParts.push(
      `<input type="text" data-other="${name}" placeholder="Type your answer" style="margin-top:6px;" />`,
    )
    formParts.push("</div>")
    formParts.push("</div>")

    formParts.push("</fieldset>")
  }

  formParts.push('<div class="actions">')
  formParts.push('<button class="btn primary" type="submit">Submit</button>')
  formParts.push(
    '<button class="btn" type="button" id="btnCancel">Cancel</button>',
  )
  formParts.push("</div>")
  formParts.push("</form>")

  elDetail.innerHTML = headerParts.join("") + formParts.join("")

  const form = document.getElementById("answerForm")
  const btnCancel = document.getElementById("btnCancel")

  btnCancel.addEventListener("click", () => {
    vscode.postMessage({ type: "cancel", id: item.id })
  })

  form.addEventListener("submit", (e) => {
    e.preventDefault()
    /** @type {Record<string, string>} */
    const answers = {}
    const fieldsets = Array.from(form.querySelectorAll("fieldset"))

    for (const fs of fieldsets) {
      const header = fs.getAttribute("data-header")
      const multi = fs.getAttribute("data-multi") === "1"
      const inputs = Array.from(
        fs.querySelectorAll('input[type="checkbox"], input[type="radio"]'),
      )
      const otherInput = fs.querySelector('input[type="text"]')

      if (!header) continue

      if (multi) {
        const checked = inputs.filter((i) => i.checked).map((i) => i.value)
        if (checked.length === 0) {
          setToast(`Please answer: ${header}`)
          return
        }
        const labels = checked.filter((v) => v !== "__other__")
        if (checked.includes("__other__")) {
          const otherText = String(otherInput?.value ?? "").trim()
          if (!otherText) {
            setToast(`Please enter Other for: ${header}`)
            return
          }
          labels.push(otherText)
        }
        answers[header] = labels.join(", ")
        continue
      }

      const checked = inputs.find((i) => i.checked)
      if (!checked) {
        setToast(`Please answer: ${header}`)
        return
      }
      if (checked.value === "__other__") {
        const otherText = String(otherInput?.value ?? "").trim()
        if (!otherText) {
          setToast(`Please enter Other for: ${header}`)
          return
        }
        answers[header] = otherText
      } else {
        answers[header] = checked.value
      }
    }

    vscode.postMessage({ type: "answer", id: item.id, answers })
  })
}

function renderDetail() {
  const id = model.selectedId
  if (!id) return renderEmptyDetail()
  const item = model.items.find((i) => i.id === id)
  if (!item) return renderEmptyDetail()
  renderDetailForItem(item)
}

elList.addEventListener("click", (e) => {
  const target = e.target.closest("[data-id]")
  if (!target) return
  const id = target.getAttribute("data-id")
  if (!id) return
  const item = model.items.find((i) => i.id === id)
  if (!item) return

  model.selectedId = id
  vscode.setState({ selectedId: id })
  renderList()
  renderDetail()
})

btnAnswerNext.addEventListener("click", () => {
  const active = model.items.find((i) => i.state === "active")
  if (active) {
    model.selectedId = active.id
    vscode.setState({ selectedId: active.id })
    renderList()
    renderDetail()
    return
  }
  const next = model.items.find((i) => i.state === "pending")
  if (!next) return
  model.selectedId = next.id
  vscode.setState({ selectedId: next.id })
  renderList()
  renderDetail()
})

btnClearHistory.addEventListener("click", () => {
  vscode.postMessage({ type: "clearHistory" })
})

window.addEventListener("message", (event) => {
  const msg = event.data
  if (!msg || !msg.type) return

  switch (msg.type) {
    case "state": {
      model.items = msg.state.items || []
      const persisted = vscode.getState()?.selectedId
      if (persisted && !model.selectedId) model.selectedId = persisted
      if (model.selectedId && !model.items.some((i) => i.id === model.selectedId)) {
        model.selectedId = undefined
      }
      if (!model.selectedId) {
        const active = model.items.find((i) => i.state === "active")
        const pending = model.items.find((i) => i.state === "pending")
        model.selectedId = active?.id ?? pending?.id
        if (model.selectedId) vscode.setState({ selectedId: model.selectedId })
      }
      renderList()
      renderDetail()
      break
    }
    case "activated": {
      model.selectedId = msg.id
      vscode.setState({ selectedId: msg.id })
      renderList()
      renderDetail()
      break
    }
    case "activationDenied": {
      setToast(msg.reason || "Unable to activate question.")
      break
    }
    case "selected": {
      model.selectedId = msg.id
      vscode.setState({ selectedId: msg.id })
      renderList()
      renderDetail()
      break
    }
    case "toast": {
      setToast(msg.message)
      break
    }
    default:
      break
  }
})

vscode.postMessage({ type: "ready" })
