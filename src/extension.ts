import * as vscode from "vscode";
import { JsonPath, JsonPrimitive, parseJsonlText, updateJsonlLineValue } from "./jsonlModel";

const COMMAND_OPEN_JSONL_PREVIEW = "better-jsonl-preview.openJsonlPreview";
const JSONL_EXTENSIONS = new Set([".jsonl", ".ndjson"]);

interface JsonlPreviewSession {
  panel: vscode.WebviewPanel;
  uri: vscode.Uri;
  selectedLineIndex: number;
  baseTitle: string;
  dirtyIndicator: boolean;
}

interface WebviewReadyMessage {
  type: "ready";
}

interface SelectLineMessage {
  type: "selectLine";
  lineIndex: number;
}

interface EditValueMessage {
  type: "editValue";
  lineIndex: number;
  path: JsonPath;
  value: JsonPrimitive;
}

type WebviewMessage = WebviewReadyMessage | SelectLineMessage | EditValueMessage;

const sessions = new Map<string, JsonlPreviewSession>();
const suppressedDocumentChanges = new Set<string>();

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_OPEN_JSONL_PREVIEW, () => openJsonlPreview(context.extensionUri)),
    vscode.workspace.onDidChangeTextDocument((event) => refreshChangedDocument(event.document)),
    vscode.window.onDidChangeTextEditorVisibleRanges(syncPreviewScrollFromEditor)
  );
}

export function deactivate(): void {
  sessions.clear();
  suppressedDocumentChanges.clear();
}

async function openJsonlPreview(extensionUri: vscode.Uri): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isJsonlUri(editor.document.uri)) {
    vscode.window.showWarningMessage("Open a .jsonl or .ndjson file before launching Better JSONL Preview.");
    return;
  }

  const key = editor.document.uri.toString();
  const existingSession = sessions.get(key);
  if (existingSession) {
    existingSession.panel.reveal(vscode.ViewColumn.Beside);
    postDocumentModel(existingSession, editor.document);
    return;
  }

  const baseTitle = `Better JSONL Preview: ${editor.document.fileName.split(/[\\/]/).pop() ?? "document"}`;
  const panel = vscode.window.createWebviewPanel(
    "clipboard-format-preview-jsonl",
    baseTitle,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      localResourceRoots: [extensionUri],
      retainContextWhenHidden: true
    }
  );

  const session: JsonlPreviewSession = {
    panel,
    uri: editor.document.uri,
    selectedLineIndex: editor.selection.active.line,
    baseTitle,
    dirtyIndicator: false
  };

  sessions.set(key, session);
  panel.webview.html = renderJsonlPreviewHtml(panel.webview);
  panel.webview.onDidReceiveMessage((message: unknown) => {
    handleWebviewMessage(session, message);
  });
  panel.onDidDispose(() => {
    sessions.delete(key);
  });
}

async function handleWebviewMessage(session: JsonlPreviewSession, message: unknown): Promise<void> {
  if (!isWebviewMessage(message)) {
    return;
  }

  if (message.type === "ready") {
    const document = await vscode.workspace.openTextDocument(session.uri);
    postDocumentModel(session, document);
    return;
  }

  if (message.type === "selectLine") {
    session.selectedLineIndex = message.lineIndex;
    return;
  }

  const document = await vscode.workspace.openTextDocument(session.uri);
  const result = updateJsonlLineValue(document.getText(), message.lineIndex, message.path, message.value);
  if (!result.ok) {
    postError(session, result.error);
    return;
  }

  const line = document.lineAt(message.lineIndex);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, line.range, result.line);

  suppressedDocumentChanges.add(document.uri.toString());
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    suppressedDocumentChanges.delete(document.uri.toString());
    postError(session, "VS Code rejected the edit.");
    return;
  }

  session.selectedLineIndex = message.lineIndex;
  postDocumentModel(session, document);
  setSessionDirtyIndicator(session, true);
  session.panel.webview.postMessage({ type: "editApplied", lineIndex: message.lineIndex });
}

function setSessionDirtyIndicator(session: JsonlPreviewSession, dirty: boolean): void {
  session.dirtyIndicator = dirty;
  session.panel.title = dirty ? `${session.baseTitle}\u2003●` : session.baseTitle;
}

function refreshChangedDocument(document: vscode.TextDocument): void {
  const key = document.uri.toString();
  if (suppressedDocumentChanges.has(key)) {
    suppressedDocumentChanges.delete(key);
    return;
  }

  const session = sessions.get(key);
  if (session) {
    postDocumentModel(session, document);
  }
}

function syncPreviewScrollFromEditor(event: vscode.TextEditorVisibleRangesChangeEvent): void {
  const editor = event.textEditor;
  if (!isJsonlUri(editor.document.uri) || event.visibleRanges.length === 0) {
    return;
  }

  const session = sessions.get(editor.document.uri.toString());
  if (!session) {
    return;
  }

  const lineIndex = event.visibleRanges[0].start.line;
  session.selectedLineIndex = lineIndex;
  session.panel.webview.postMessage({
    type: "scrollToLine",
    lineIndex
  });
}

function postDocumentModel(session: JsonlPreviewSession, document: vscode.TextDocument): void {
  const model = parseJsonlText(document.getText());
  const maxLineIndex = Math.max(0, model.rows.length - 1);
  session.selectedLineIndex = Math.min(session.selectedLineIndex, maxLineIndex);

  session.panel.webview.postMessage({
    type: "model",
    rows: model.rows.map((row) => ({
      kind: row.kind,
      lineIndex: row.lineIndex,
      lineNumber: row.lineNumber,
      raw: row.raw,
      summary: row.summary,
      error: row.kind === "invalid" ? row.error : undefined,
      value: row.kind === "json" ? row.value : undefined
    })),
    filePath: document.uri.fsPath || document.uri.path,
    selectedLineIndex: session.selectedLineIndex
  });
}

function postError(session: JsonlPreviewSession, error: string): void {
  session.panel.webview.postMessage({
    type: "error",
    error
  });
}

function renderJsonlPreviewHtml(webview: vscode.Webview): string {
  const nonce = createNonce();

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"
  >
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Better JSONL Preview</title>
  <style>
    :root {
      color-scheme: light dark;
      --jfp-bg: var(--vscode-editor-background);
      --jfp-fg: var(--vscode-editor-foreground);
      --jfp-muted: var(--vscode-descriptionForeground);
      --jfp-border: var(--vscode-panel-border);
      --jfp-input-bg: var(--vscode-input-background);
      --jfp-input-fg: var(--vscode-input-foreground);
      --jfp-input-border: var(--vscode-focusBorder);
      --jfp-error: var(--vscode-errorForeground);
      --jfp-key: #2b2b2b;
      --jfp-punct: #073642;
      --jfp-string: #c64613;
      --jfp-number: #1b8bd8;
      --jfp-boolean: #07820f;
      --jfp-null: #e53946;
    }

    * {
      box-sizing: border-box;
    }

    html,
    body {
      height: 100%;
    }

    body {
      margin: 0;
      padding: 0;
      color: var(--jfp-fg);
      background: var(--jfp-bg);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      line-height: 1.45;
    }

    button, input, textarea, select {
      font: inherit;
    }

    .shell {
      display: grid;
      grid-template-rows: calc(var(--vscode-editor-line-height, 20px) + 2px) minmax(0, 1fr);
      width: 100%;
      height: 100%;
      min-width: 0;
      min-height: 0;
      position: relative;
    }

    .editor-scroll {
      overflow: auto;
      min-width: 0;
      min-height: 0;
      padding: 0;
    }

    .editor-scroll::-webkit-scrollbar {
      width: 14px;
      height: 14px;
    }

    .editor-scroll::-webkit-scrollbar-thumb {
      background: var(--vscode-scrollbarSlider-background);
    }

    .editor-scroll::-webkit-scrollbar-thumb:hover {
      background: var(--vscode-scrollbarSlider-hoverBackground);
    }

    .editor-scroll::-webkit-scrollbar-thumb:active {
      background: var(--vscode-scrollbarSlider-activeBackground);
    }

    .line-number {
      display: block;
      color: var(--jfp-muted);
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: var(--vscode-editor-line-height, 20px);
      text-align: right;
      white-space: nowrap;
      user-select: none;
    }

    .summary {
      display: none;
    }

    .status {
      color: var(--jfp-muted);
      font-size: 11px;
    }

    .status.invalid,
    .error {
      color: var(--jfp-error);
    }

    .empty-state,
    .raw-block {
      color: var(--jfp-muted);
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      height: calc(var(--vscode-editor-line-height, 20px) + 2px);
      margin: 0;
      padding-left: 14px;
      padding-right: 14px;
      background: var(--jfp-bg);
      border-bottom: 1px solid var(--jfp-border);
      color: var(--jfp-muted);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }

    .title {
      font-weight: 400;
    }

    .toast {
      min-height: 20px;
      color: var(--jfp-muted);
      font-size: 12px;
    }

    .find-widget {
      position: fixed;
      top: 6px;
      right: 16px;
      z-index: 20;
      display: flex;
      align-items: center;
      gap: 4px;
      min-height: 34px;
      max-width: calc(100vw - 32px);
      padding: 3px 6px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-editorWidget-background, var(--jfp-bg));
      border: 1px solid var(--vscode-widget-border, var(--jfp-border));
      border-radius: 9px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, .18);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }

    .find-widget.hidden {
      display: none;
    }

    .find-input {
      width: min(330px, 36vw);
      height: 26px;
      padding: 2px 9px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid transparent;
      border-radius: 6px;
      outline: none;
    }

    .find-input:focus {
      border-color: var(--vscode-focusBorder);
    }

    .find-button {
      width: 28px;
      height: 26px;
      padding: 0;
      color: var(--vscode-icon-foreground, var(--jfp-muted));
      background: transparent;
      border: 0;
      border-radius: 4px;
      outline: none;
      line-height: 1;
    }

    .find-button:hover,
    .find-button.active {
      background: var(--vscode-toolbar-hoverBackground);
    }

    .find-button:disabled {
      opacity: .38;
    }

    .find-button:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }

    .find-status {
      min-width: 76px;
      padding: 0 6px;
      color: var(--jfp-muted);
      white-space: nowrap;
    }

    .find-status.error,
    .find-status.empty {
      color: var(--jfp-error);
    }

    .code-grid {
      display: grid;
      grid-template-columns: max-content max-content;
      column-gap: 8px;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: var(--vscode-editor-line-height, 20px);
      min-width: max-content;
      padding-bottom: 24px;
      padding-right: 0;
      letter-spacing: 0;
      white-space: pre;
    }

    .gutter-cell {
      min-height: var(--vscode-editor-line-height, 20px);
      padding-left: 8px;
      padding-right: 6px;
    }

    .code-line {
      min-height: var(--vscode-editor-line-height, 20px);
      white-space: pre;
    }

    .gutter-cell.find-match-line,
    .code-line.find-match-line {
      background: var(--vscode-editor-findMatchHighlightBackground);
    }

    .gutter-cell.find-current-line,
    .code-line.find-current-line {
      background: var(--vscode-editor-findMatchBackground);
      outline: 1px solid var(--vscode-editor-findMatchBorder, transparent);
      outline-offset: -1px;
    }

    .load-sentinel {
      height: calc(var(--vscode-editor-line-height, 20px) * 2);
      color: var(--jfp-muted);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }

    .key {
      color: var(--jfp-key);
      white-space: nowrap;
    }

    .punct {
      color: var(--jfp-punct);
    }

    .meta {
      color: var(--jfp-muted);
      font-style: italic;
      margin-left: 8px;
    }

    .toggle {
      color: var(--jfp-punct);
      display: inline-block;
      width: 1.7ch;
      font-size: 1.18em;
      line-height: 1;
      user-select: none;
    }

    .edit-input,
    .edit-select {
      color: var(--jfp-input-fg);
      background: var(--jfp-input-bg);
      border: 1px solid var(--jfp-input-border);
      border-radius: 4px;
      min-height: var(--vscode-editor-line-height, 20px);
      max-width: min(680px, 62vw);
      min-width: 220px;
      padding: 2px 6px;
      outline: none;
      font: inherit;
      line-height: var(--vscode-editor-line-height, 20px);
      vertical-align: top;
    }

    textarea.edit-input {
      width: min(680px, 62vw);
      height: calc(var(--vscode-editor-line-height, 20px) + 2px);
      min-height: calc(var(--vscode-editor-line-height, 20px) + 2px);
      padding-top: 0;
      padding-bottom: 0;
      resize: none;
      white-space: pre;
      overflow-wrap: normal;
      overflow-y: hidden;
      overflow-x: auto;
    }

    textarea.edit-input::-webkit-scrollbar {
      height: 14px;
    }

    .edit-input.invalid {
      border-color: var(--jfp-error);
      color: var(--jfp-error);
    }

    .value {
      border-radius: 3px;
      cursor: text;
      white-space: pre;
    }

    .string {
      color: var(--jfp-string);
    }

    .number {
      color: var(--jfp-number);
    }

    .boolean {
      color: var(--jfp-boolean);
    }

    .null {
      color: var(--jfp-null);
      font-weight: 700;
    }

    @media (max-width: 720px) {
      .edit-input,
      .edit-select,
      textarea.edit-input {
        max-width: 100%;
        width: 100%;
      }
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --jfp-key: #d4d4d4;
        --jfp-punct: #9cdcfe;
        --jfp-string: #ce9178;
        --jfp-number: #b5cea8;
        --jfp-boolean: #4ec9b0;
        --jfp-null: #c586c0;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header id="header" class="header"></header>
    <section id="editor-scroll" class="editor-scroll" aria-live="polite">
      <div id="code-root"></div>
    </section>
  </main>
  <div id="find-widget" class="find-widget hidden" role="search">
    <button class="find-button" type="button" data-find-action="collapse" title="Find">›</button>
    <input id="find-input" class="find-input" type="text" spellcheck="false" autocomplete="off" aria-label="Find">
    <button class="find-button" type="button" data-find-toggle="caseSensitive" title="Match Case">Aa</button>
    <button class="find-button" type="button" data-find-toggle="wholeWord" title="Match Whole Word">ab</button>
    <button class="find-button" type="button" data-find-toggle="regex" title="Use Regular Expression">.*</button>
    <span id="find-status" class="find-status" aria-live="polite"></span>
    <button class="find-button" type="button" data-find-action="previous" title="Previous Match">↑</button>
    <button class="find-button" type="button" data-find-action="next" title="Next Match">↓</button>
    <button class="find-button" type="button" data-find-action="close" title="Close">×</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const headerRoot = document.getElementById("header");
    const scrollRoot = document.getElementById("editor-scroll");
    const codeRoot = document.getElementById("code-root");
    const findRoot = document.getElementById("find-widget");
    const findInput = document.getElementById("find-input");
    const findStatus = document.getElementById("find-status");
    const PAGE_SIZE = 30;

    let state = {
      rows: [],
      filePath: "",
      selectedLineIndex: 0,
      visibleCount: PAGE_SIZE,
      toast: "",
      editing: undefined,
      submittingEdit: false,
      submittedEditing: undefined,
      pendingEditTarget: undefined,
      pendingScrollLineIndex: undefined,
      scrollAnimationFrame: 0,
      collapsedPaths: new Set(),
      find: {
        open: false,
        query: "",
        caseSensitive: false,
        wholeWord: false,
        regex: false,
        matches: [],
        matchLineIndexes: new Set(),
        currentIndex: -1,
        error: "",
        debounceTimer: 0
      }
    };

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (!message || typeof message.type !== "string") {
        return;
      }

      if (message.type === "model") {
        const previousVisibleCount = state.visibleCount || PAGE_SIZE;
        state.rows = message.rows || [];
        state.filePath = message.filePath || "";
        state.selectedLineIndex = Number.isInteger(message.selectedLineIndex) ? message.selectedLineIndex : 0;
        state.visibleCount = Math.min(Math.max(PAGE_SIZE, previousVisibleCount), state.rows.length || PAGE_SIZE);
        state.toast = "";
        state.editing = undefined;
        state.submittingEdit = false;
        state.submittedEditing = undefined;
        pruneCollapsedPaths();
        render();
        const pendingEditTarget = state.pendingEditTarget;
        if (pendingEditTarget) {
          state.pendingEditTarget = undefined;
          beginEditTarget(pendingEditTarget);
        }
        if (Number.isInteger(state.pendingScrollLineIndex)) {
          scheduleScrollToLine(state.pendingScrollLineIndex);
        }
        if (state.find.open && state.find.query) {
          updateFindMatches(false);
        }
        return;
      }

      if (message.type === "error") {
        state.submittingEdit = false;
        if (state.submittedEditing) {
          state.editing = state.submittedEditing;
          state.submittedEditing = undefined;
          renderEditor();
          focusCurrentEditor();
        }
        state.toast = message.error || "Unable to apply edit.";
        renderHeaderOnly();
        return;
      }

      if (message.type === "editApplied") {
        state.toast = "";
        renderHeaderOnly();
      }

      if (message.type === "scrollToLine") {
        if (!Number.isInteger(message.lineIndex)) {
          return;
        }
        scheduleScrollToLine(message.lineIndex);
      }
    });

    scrollRoot.addEventListener("scroll", () => {
      maybeLoadMoreRows();
    });

    document.addEventListener("pointerdown", (event) => {
      commitActiveEditFromOutsidePointer(event);
    }, true);

    document.addEventListener("keydown", (event) => {
      handleGlobalKeydown(event);
    }, true);

    findRoot.addEventListener("input", (event) => {
      if (event.target !== findInput) {
        return;
      }
      state.find.query = findInput.value;
      scheduleFindUpdate();
      renderFindWidget();
    });

    findRoot.addEventListener("click", (event) => {
      const target = event.target;
      if (!target || typeof target.closest !== "function") {
        return;
      }

      const toggle = target.closest("[data-find-toggle]");
      if (toggle) {
        const key = toggle.getAttribute("data-find-toggle");
        state.find[key] = !state.find[key];
        updateFindMatches(true);
        focusFindInput();
        return;
      }

      const action = target.closest("[data-find-action]");
      if (!action) {
        return;
      }

      const name = action.getAttribute("data-find-action");
      if (name === "close") {
        closeFindWidget();
        return;
      }

      if (name === "next") {
        navigateFind(1);
        return;
      }

      if (name === "previous") {
        navigateFind(-1);
        return;
      }

      focusFindInput();
    });

    scrollRoot.addEventListener("click", (event) => {
      const activeEditor = codeRoot.querySelector(".edit-input[data-edit-path], .edit-select[data-edit-path]");
      if (activeEditor) {
        const target = event.target;
        if (!target || typeof target.closest !== "function" || !target.closest(".edit-input, .edit-select")) {
          return;
        }
      }

      const toggle = event.target.closest("[data-toggle-path]");
      if (toggle) {
        const key = toggle.getAttribute("data-toggle-path");
        if (state.collapsedPaths.has(key)) {
          state.collapsedPaths.delete(key);
        } else {
          state.collapsedPaths.add(key);
        }
        renderEditor();
        if (state.find.open && state.find.query) {
          updateFindMatches(false);
        }
        return;
      }

      const value = event.target.closest("[data-edit-path]");
      if (!value || value.classList.contains("edit-input") || value.classList.contains("edit-select")) {
        return;
      }
      if (state.submittingEdit) {
        state.pendingEditTarget = getEditTarget(value);
        return;
      }
      beginEdit(value);
    });

    scrollRoot.addEventListener("input", (event) => {
      const input = event.target.closest("textarea.edit-input");
      if (!input) {
        return;
      }
      resizeTextareaToContent(input);
    });

    scrollRoot.addEventListener("keydown", (event) => {
      const input = event.target.closest("[data-edit-path]");
      if (!input || (!input.classList.contains("edit-input") && !input.classList.contains("edit-select"))) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        cancelEdit();
        return;
      }

      if (event.key !== "Enter") {
        return;
      }

      if (input.tagName === "TEXTAREA" && event.shiftKey) {
        return;
      }

      if (input.tagName === "TEXTAREA" && !(event.metaKey || event.ctrlKey)) {
        return;
      }

      event.preventDefault();
      sendEdit(input);
    });

    function render() {
      renderHeader();
      renderEditor();
      renderFindWidget();
    }

    function renderEditor() {
      const rows = visibleRows();
      if (rows.length === 0) {
        codeRoot.innerHTML = '<div class="code-grid"><div class="gutter-cell"></div><div class="code-line empty-state">No JSONL rows.</div></div>';
        return;
      }

      const lines = buildCodeLines(rows);
      const body = lines.map((line) => renderCodeGridLine(line)).join("");
      const sentinel = state.visibleCount < state.rows.length
        ? '<div class="gutter-cell"></div><div class="code-line load-sentinel">Loading more rows...</div>'
        : "";

      codeRoot.innerHTML = '<div class="code-grid">' + body + sentinel + '</div>';
    }

    function buildCodeLines(rows) {
      const lines = [];
      for (const row of rows) {
        for (const line of buildJsonlItemLines(row)) {
          lines.push({
            ...line,
            lineIndex: row.lineIndex,
            visualLineIndex: lines.length,
            text: htmlToText(line.html)
          });
        }
      }
      return lines;
    }

    function buildJsonlItemLines(row) {
      const withAnchor = (lines) => {
        if (lines.length > 0) {
          lines[0] = { ...lines[0], sourceLineIndex: row.lineIndex };
        }
        return lines;
      };

      if (row.kind === "empty") {
        return withAnchor([{ lineNumber: row.lineNumber, html: '<span class="meta">Empty line</span>' }]);
      }

      if (row.kind === "invalid") {
        return withAnchor([
          { lineNumber: row.lineNumber, html: '<span class="error">' + escapeHtml(row.error || "Invalid JSON") + '</span>' },
          { lineNumber: row.lineNumber, html: '<span class="meta">' + escapeHtml(row.raw || "") + '</span>' }
        ]);
      }

      return withAnchor(buildRootJsonLines(row.value, row.lineIndex, row.lineNumber));
    }

    function renderHeaderOnly() {
      const toast = headerRoot.querySelector(".toast");
      if (toast) {
        toast.textContent = state.toast || "";
      }
    }

    function renderHeader() {
      headerRoot.innerHTML =
        '<div><span class="title">' + renderFileCrumbs(state.filePath) + '</span></div>' +
        '<div class="toast">' + escapeHtml(state.toast || "") + '</div>';
    }

    function renderFileCrumbs(filePath) {
      const parts = String(filePath || "").split(/[\\\\/]/).filter(Boolean);
      if (parts.length === 0) {
        return '{} JSONL Preview';
      }

      const fileName = parts[parts.length - 1];
      const parent = parts.length > 1 ? parts[parts.length - 2] : "";
      return (parent ? escapeHtml(parent) + ' <span class="meta">&gt;</span> ' : "") +
        '<span class="punct">{}</span> ' +
        escapeHtml(fileName);
    }

    function renderFindWidget() {
      findRoot.classList.toggle("hidden", !state.find.open);
      if (!state.find.open) {
        return;
      }

      if (findInput.value !== state.find.query) {
        findInput.value = state.find.query;
      }

      for (const button of findRoot.querySelectorAll("[data-find-toggle]")) {
        const key = button.getAttribute("data-find-toggle");
        const active = Boolean(state.find[key]);
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", active ? "true" : "false");
      }

      const hasMatches = state.find.matches.length > 0 && !state.find.error;
      for (const button of findRoot.querySelectorAll('[data-find-action="next"], [data-find-action="previous"]')) {
        button.disabled = !hasMatches;
      }

      findStatus.classList.toggle("error", Boolean(state.find.error));
      findStatus.classList.toggle("empty", Boolean(state.find.query && !state.find.error && state.find.matches.length === 0));
      if (state.find.error) {
        findStatus.textContent = "Invalid regex";
      } else if (!state.find.query) {
        findStatus.textContent = "";
      } else if (state.find.matches.length === 0) {
        findStatus.textContent = "No results";
      } else {
        findStatus.textContent = (state.find.currentIndex + 1) + " of " + state.find.matches.length;
      }
    }

    function visibleRows() {
      return state.rows.slice(0, Math.min(state.visibleCount, state.rows.length));
    }

    function maybeLoadMoreRows() {
      if (state.visibleCount >= state.rows.length) {
        return;
      }

      const remaining = scrollRoot.scrollHeight - scrollRoot.scrollTop - scrollRoot.clientHeight;
      if (remaining > 600) {
        return;
      }

      const scrollTop = scrollRoot.scrollTop;
      state.visibleCount = Math.min(state.visibleCount + PAGE_SIZE, state.rows.length);
      renderEditor();
      scrollRoot.scrollTop = scrollTop;
    }

    function buildRootJsonLines(value, lineIndex, lineNumber) {
      if (Array.isArray(value)) {
        const pathKey = pathStateKey(lineIndex, []);
        const collapsed = state.collapsedPaths.has(pathKey);
        if (collapsed) {
          return [{
            lineNumber,
            html: '<span class="toggle" data-toggle-path="' + escapeHtml(pathKey) + '">▸</span><span class="punct">[</span><span class="meta"> ... ' + value.length + ' items</span><span class="punct"> ]</span>'
          }];
        }

        return [
          { lineNumber, html: '<span class="toggle" data-toggle-path="' + escapeHtml(pathKey) + '">▾</span><span class="punct">[</span>' },
          ...buildJsonLines(value, [], 1, lineIndex, lineNumber),
          { lineNumber, html: '<span class="punct">]</span>' }
        ];
      }

      if (value && typeof value === "object") {
        const pathKey = pathStateKey(lineIndex, []);
        const collapsed = state.collapsedPaths.has(pathKey);
        const keyCount = Object.keys(value).length;
        if (collapsed) {
          return [{
            lineNumber,
            html: '<span class="toggle" data-toggle-path="' + escapeHtml(pathKey) + '">▸</span><span class="punct">{</span><span class="meta"> ... ' + keyCount + ' keys</span><span class="punct"> }</span>'
          }];
        }

        return [
          { lineNumber, html: '<span class="toggle" data-toggle-path="' + escapeHtml(pathKey) + '">▾</span><span class="punct">{</span>' },
          ...buildJsonLines(value, [], 1, lineIndex, lineNumber),
          { lineNumber, html: '<span class="punct">}</span>' }
        ];
      }

      return [{ lineNumber, html: renderPrimitive(value, [], undefined, lineIndex, 0) }];
    }

    function buildJsonLines(value, path, depth, lineIndex, lineNumber) {
      if (Array.isArray(value)) {
        return value.flatMap((item, index) => buildJsonValueLines(item, path.concat([index]), String(index), depth, lineIndex, lineNumber));
      }

      if (value && typeof value === "object") {
        return Object.entries(value).flatMap(([key, childValue]) => buildJsonValueLines(childValue, path.concat([key]), key, depth, lineIndex, lineNumber));
      }

      return [{ lineNumber, html: renderPrimitive(value, path, undefined, lineIndex, depth) }];
    }

    function buildJsonValueLines(value, path, key, depth, lineIndex, lineNumber) {
      if (Array.isArray(value)) {
        return buildCollectionLines(value, path, key, depth, lineIndex, lineNumber, "[", "]", value.length + " items");
      }

      if (value && typeof value === "object") {
        return buildCollectionLines(value, path, key, depth, lineIndex, lineNumber, "{", "}", Object.keys(value).length + " keys");
      }

      return [{ lineNumber, html: renderPrimitive(value, path, key, lineIndex, depth) }];
    }

    function buildCollectionLines(value, path, key, depth, lineIndex, lineNumber, open, close, meta) {
      const pathKey = pathStateKey(lineIndex, path);
      const collapsed = state.collapsedPaths.has(pathKey);
      const prefix = renderIndent(depth) + '<span class="toggle" data-toggle-path="' + escapeHtml(pathKey) + '">' + (collapsed ? '▸' : '▾') + '</span>' + renderKey(key);

      if (collapsed) {
        return [{ lineNumber, html: prefix + '<span class="punct">' + open + '</span><span class="meta"> ... ' + escapeHtml(meta) + '</span><span class="punct"> ' + close + '</span>' }];
      }

      const childLines = Array.isArray(value)
        ? value.flatMap((item, index) => buildJsonValueLines(item, path.concat([index]), String(index), depth + 1, lineIndex, lineNumber))
        : Object.entries(value).flatMap(([childKey, childValue]) => buildJsonValueLines(childValue, path.concat([childKey]), childKey, depth + 1, lineIndex, lineNumber));

      return [
        { lineNumber, html: prefix + '<span class="punct">' + open + '</span>' },
        ...childLines,
        { lineNumber, html: renderIndent(depth) + '<span class="punct">' + close + '</span>' }
      ];
    }

    function renderPrimitive(value, path, key, lineIndex, depth) {
      const encodedPath = encodeURIComponent(JSON.stringify(path));
      const pathKey = JSON.stringify(path);
      const editing = state.editing &&
        state.editing.lineIndex === lineIndex &&
        state.editing.pathKey === pathKey;

      const prefix = renderIndent(depth) + renderKey(key);
      if (editing) {
        return prefix + renderPrimitiveEditor(value, encodedPath, lineIndex);
      }

      if (typeof value === "string") {
        return prefix +
          '<span class="value string" data-kind="string" data-line-index="' + lineIndex + '" data-edit-path="' + encodedPath + '">' +
          '&quot;' + escapeHtml(value) + '&quot;' +
          '</span>';
      }

      if (typeof value === "number") {
        return prefix +
          '<span class="value number" data-kind="number" data-line-index="' + lineIndex + '" data-edit-path="' + encodedPath + '">' +
          escapeHtml(String(value)) +
          '</span>';
      }

      if (typeof value === "boolean") {
        return prefix +
          '<span class="value boolean" data-kind="boolean" data-line-index="' + lineIndex + '" data-edit-path="' + encodedPath + '">' +
          String(value) +
          '</span>';
      }

      return prefix + '<span class="null">NULL</span>';
    }

    function renderPrimitiveEditor(value, encodedPath, lineIndex) {
      if (typeof value === "string") {
        const rows = Math.max(1, value.split("\\n").length);
        return '<textarea class="edit-input string" rows="' + rows + '" wrap="off" data-kind="string" data-original-value="' + escapeHtml(JSON.stringify(value)) + '" data-line-index="' + lineIndex + '" data-edit-path="' + encodedPath + '">' +
          escapeHtml(value) +
          '</textarea>';
      }

      if (typeof value === "number") {
        return '<input class="edit-input number" data-kind="number" data-original-value="' + escapeHtml(JSON.stringify(value)) + '" data-line-index="' + lineIndex + '" data-edit-path="' + encodedPath + '" value="' + escapeHtml(String(value)) + '">';
      }

      if (typeof value === "boolean") {
        return '<select class="edit-select boolean" data-kind="boolean" data-original-value="' + escapeHtml(JSON.stringify(value)) + '" data-line-index="' + lineIndex + '" data-edit-path="' + encodedPath + '">' +
          '<option value="true"' + (value ? " selected" : "") + '>true</option>' +
          '<option value="false"' + (!value ? " selected" : "") + '>false</option>' +
          '</select>';
      }

      return '<span class="null">NULL</span>';
    }

    function renderKey(key) {
      if (key === undefined) {
        return "";
      }
      return '<span class="key">' + escapeHtml(key) + ':</span>';
    }

    function renderIndent(depth) {
      return '<span class="indent">' + "  ".repeat(depth) + '</span>';
    }

    function renderCodeGridLine(line) {
      const anchor = Number.isInteger(line.sourceLineIndex)
        ? ' data-jsonl-line-index="' + line.sourceLineIndex + '"'
        : "";
      const visualAnchor = Number.isInteger(line.visualLineIndex)
        ? ' data-visual-line-index="' + line.visualLineIndex + '"'
        : "";
      const findClass = findLineClass(line.visualLineIndex);
      return '<div class="gutter-cell' + findClass + '"' + anchor + visualAnchor + '><span class="line-number">' + line.lineNumber + '</span></div>' +
        '<div class="code-line' + findClass + '"' + anchor + visualAnchor + '>' + line.html + '</div>';
    }

    function findLineClass(visualLineIndex) {
      if (!state.find.open || !state.find.query || state.find.error || !Number.isInteger(visualLineIndex)) {
        return "";
      }

      const current = state.find.matches[state.find.currentIndex];
      if (current && current.visualLineIndex === visualLineIndex) {
        return " find-current-line";
      }

      return state.find.matchLineIndexes.has(visualLineIndex) ? " find-match-line" : "";
    }

    function pathStateKey(lineIndex, path) {
      return lineIndex + ':' + JSON.stringify(path);
    }

    function scheduleScrollToLine(lineIndex) {
      if (state.editing || state.submittingEdit) {
        state.pendingScrollLineIndex = lineIndex;
        return;
      }

      state.pendingScrollLineIndex = lineIndex;
      if (state.scrollAnimationFrame) {
        cancelAnimationFrame(state.scrollAnimationFrame);
      }
      state.scrollAnimationFrame = requestAnimationFrame(() => {
        state.scrollAnimationFrame = 0;
        scrollToLine(state.pendingScrollLineIndex);
      });
    }

    function scrollToLine(lineIndex) {
      if (!Number.isInteger(lineIndex) || state.rows.length === 0) {
        return;
      }

      const maxLineIndex = state.rows.length - 1;
      const targetLineIndex = Math.max(0, Math.min(lineIndex, maxLineIndex));
      state.pendingScrollLineIndex = undefined;

      if (targetLineIndex >= state.visibleCount) {
        state.visibleCount = Math.min(Math.max(PAGE_SIZE, targetLineIndex + 1), state.rows.length);
        renderEditor();
      }

      const target = codeRoot.querySelector('[data-jsonl-line-index="' + targetLineIndex + '"]');
      if (!target) {
        return;
      }

      scrollRoot.scrollTop = target.offsetTop;
    }

    function handleGlobalKeydown(event) {
      const key = String(event.key || "").toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === "f") {
        event.preventDefault();
        event.stopPropagation();
        openFindWidget();
        return;
      }

      if (!state.find.open) {
        return;
      }

      const target = event.target;
      const inFindWidget = target && typeof target.closest === "function" && target.closest(".find-widget");
      if (!inFindWidget) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeFindWidget();
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        navigateFind(event.shiftKey ? -1 : 1);
      }
    }

    function openFindWidget() {
      state.find.open = true;
      renderFindWidget();
      focusFindInput(true);
      if (state.find.query) {
        updateFindMatches(false);
      }
    }

    function closeFindWidget() {
      state.find.open = false;
      state.find.error = "";
      state.find.matches = [];
      state.find.matchLineIndexes = new Set();
      state.find.currentIndex = -1;
      if (state.find.debounceTimer) {
        clearTimeout(state.find.debounceTimer);
        state.find.debounceTimer = 0;
      }
      renderFindWidget();
      renderEditorPreservingActiveEdit();
    }

    function focusFindInput(selectText) {
      findInput.focus();
      if (selectText) {
        findInput.select();
      }
    }

    function scheduleFindUpdate() {
      if (state.find.debounceTimer) {
        clearTimeout(state.find.debounceTimer);
      }
      state.find.debounceTimer = setTimeout(() => {
        state.find.debounceTimer = 0;
        updateFindMatches(true);
      }, 120);
    }

    function updateFindMatches(resetCurrent) {
      const query = state.find.query;
      state.find.error = "";
      state.find.matches = [];
      state.find.matchLineIndexes = new Set();

      if (!query) {
        state.find.currentIndex = -1;
        renderFindWidget();
        renderEditorPreservingActiveEdit();
        return;
      }

      const matcher = createFindMatcher(query);
      if (!matcher.ok) {
        state.find.error = matcher.error;
        state.find.currentIndex = -1;
        renderFindWidget();
        renderEditorPreservingActiveEdit();
        return;
      }

      const lines = buildCodeLines(state.rows);
      const matches = [];
      for (const line of lines) {
        if (matcher.matches(line.text)) {
          matches.push({
            visualLineIndex: line.visualLineIndex,
            lineIndex: line.lineIndex
          });
        }
      }

      state.find.matches = matches;
      state.find.matchLineIndexes = new Set(matches.map((match) => match.visualLineIndex));
      if (matches.length === 0) {
        state.find.currentIndex = -1;
        renderFindWidget();
        renderEditorPreservingActiveEdit();
        return;
      }

      if (resetCurrent || state.find.currentIndex < 0 || state.find.currentIndex >= matches.length) {
        state.find.currentIndex = 0;
      }

      revealFindMatch();
    }

    function createFindMatcher(query) {
      if (state.find.regex) {
        try {
          const flags = "g" + (state.find.caseSensitive ? "" : "i") + "u";
          const expression = new RegExp(query, flags);
          return {
            ok: true,
            matches(text) {
              expression.lastIndex = 0;
              let match;
              while ((match = expression.exec(text)) !== null) {
                const value = match[0] || "";
                if (!state.find.wholeWord || isWholeWordMatch(text, match.index, value.length)) {
                  return true;
                }
                if (value.length === 0) {
                  expression.lastIndex += 1;
                }
              }
              return false;
            }
          };
        } catch {
          return { ok: false, error: "Invalid regex" };
        }
      }

      const needle = state.find.caseSensitive ? query : query.toLowerCase();
      return {
        ok: true,
        matches(text) {
          const haystack = state.find.caseSensitive ? text : text.toLowerCase();
          let index = haystack.indexOf(needle);
          while (index >= 0) {
            if (!state.find.wholeWord || isWholeWordMatch(text, index, query.length)) {
              return true;
            }
            index = haystack.indexOf(needle, index + Math.max(needle.length, 1));
          }
          return false;
        }
      };
    }

    function isWholeWordMatch(text, start, length) {
      if (length <= 0) {
        return false;
      }
      const before = start > 0 ? text[start - 1] : "";
      const after = start + length < text.length ? text[start + length] : "";
      return !isWordCharacter(before) && !isWordCharacter(after);
    }

    function isWordCharacter(char) {
      return /^[A-Za-z0-9_]$/.test(char || "");
    }

    function navigateFind(direction) {
      if (!state.find.query) {
        focusFindInput();
        return;
      }

      if (state.find.matches.length === 0 || state.find.error) {
        updateFindMatches(true);
        focusFindInput();
        return;
      }

      const length = state.find.matches.length;
      state.find.currentIndex = (state.find.currentIndex + direction + length) % length;
      revealFindMatch();
      focusFindInput();
    }

    function revealFindMatch() {
      const match = state.find.matches[state.find.currentIndex];
      if (!match) {
        renderFindWidget();
        renderEditorPreservingActiveEdit();
        return;
      }

      if (match.lineIndex >= state.visibleCount) {
        state.visibleCount = Math.min(Math.max(PAGE_SIZE, match.lineIndex + 1), state.rows.length);
      }

      renderEditorPreservingActiveEdit();
      renderFindWidget();
      requestAnimationFrame(() => {
        const target = codeRoot.querySelector('[data-visual-line-index="' + match.visualLineIndex + '"].code-line');
        if (!target) {
          return;
        }
        const margin = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--vscode-editor-line-height")) || 20;
        scrollRoot.scrollTop = Math.max(0, target.offsetTop - margin);
      });
    }

    function renderEditorPreservingActiveEdit() {
      const snapshot = captureActiveEditor();
      renderEditor();
      restoreActiveEditor(snapshot);
    }

    function captureActiveEditor() {
      const editor = codeRoot.querySelector(".edit-input[data-edit-path], .edit-select[data-edit-path]");
      if (!editor) {
        return undefined;
      }

      return {
        editPath: editor.getAttribute("data-edit-path"),
        value: editor.value,
        focused: document.activeElement === editor,
        selectionStart: typeof editor.selectionStart === "number" ? editor.selectionStart : undefined,
        selectionEnd: typeof editor.selectionEnd === "number" ? editor.selectionEnd : undefined
      };
    }

    function restoreActiveEditor(snapshot) {
      if (!snapshot || !snapshot.editPath) {
        return;
      }

      const editor = codeRoot.querySelector('[data-edit-path="' + snapshot.editPath + '"]');
      if (!editor || (!editor.classList.contains("edit-input") && !editor.classList.contains("edit-select"))) {
        return;
      }

      editor.value = snapshot.value;
      if (editor.tagName === "TEXTAREA") {
        resizeTextareaToContent(editor);
      }

      if (snapshot.focused) {
        editor.focus();
        if (typeof snapshot.selectionStart === "number" && typeof snapshot.selectionEnd === "number" && editor.setSelectionRange) {
          editor.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
        }
      }
    }

    function pruneCollapsedPaths() {
      const visibleLineIndexes = new Set(state.rows.map((row) => row.lineIndex));
      state.collapsedPaths = new Set(Array.from(state.collapsedPaths).filter((key) => {
        const separator = key.indexOf(":");
        if (separator < 0) {
          return false;
        }
        return visibleLineIndexes.has(Number(key.slice(0, separator)));
      }));
    }

    function beginEdit(value) {
      beginEditTarget(getEditTarget(value));
    }

    function beginEditTarget(target) {
      state.editing = {
        lineIndex: target.lineIndex,
        pathKey: target.pathKey
      };
      state.toast = "";
      renderEditor();
      focusCurrentEditor(target.editPath);
    }

    function getEditTarget(value) {
      return {
        lineIndex: Number(value.getAttribute("data-line-index")),
        pathKey: decodeURIComponent(value.getAttribute("data-edit-path")),
        editPath: value.getAttribute("data-edit-path")
      };
    }

    function focusCurrentEditor(editPath) {
      const selectorPath = editPath || (state.editing ? encodeURIComponent(state.editing.pathKey) : "");
      if (!selectorPath) {
        return;
      }
      const editor = codeRoot.querySelector('[data-edit-path="' + selectorPath + '"]');
      if (!editor || (!editor.classList.contains("edit-input") && !editor.classList.contains("edit-select"))) {
        return;
      }
      if (editor.tagName === "TEXTAREA") {
        resizeTextareaToContent(editor);
      }
      editor.focus();
      if (editor.select) {
        editor.select();
      }
    }

    function commitActiveEditFromOutsidePointer(event) {
      if (state.submittingEdit) {
        return;
      }

      const activeInput = codeRoot.querySelector(".edit-input[data-edit-path], .edit-select[data-edit-path]");
      if (!activeInput) {
        return;
      }

      const target = event.target;
      if (target && typeof target.closest === "function" && target.closest(".find-widget")) {
        return;
      }

      if (target && typeof target.closest === "function" && target.closest(".edit-input, .edit-select")) {
        return;
      }

      if (isPointerOnScrollbar(scrollRoot, event)) {
        return;
      }

      const editTarget = target && typeof target.closest === "function"
        ? target.closest("[data-edit-path]")
        : undefined;

      if (
        editTarget &&
        !editTarget.classList.contains("edit-input") &&
        !editTarget.classList.contains("edit-select")
      ) {
        state.pendingEditTarget = getEditTarget(editTarget);
      } else {
        state.pendingEditTarget = undefined;
      }

      const submitted = sendEdit(activeInput);
      if (!submitted) {
        state.pendingEditTarget = undefined;
        event.preventDefault();
        event.stopPropagation();
      }
    }

    function isPointerOnScrollbar(element, event) {
      const rect = element.getBoundingClientRect();
      const verticalScrollbarWidth = element.offsetWidth - element.clientWidth;
      const horizontalScrollbarHeight = element.offsetHeight - element.clientHeight;
      const hasVerticalScrollbar = verticalScrollbarWidth > 0 && element.scrollHeight > element.clientHeight;
      const hasHorizontalScrollbar = horizontalScrollbarHeight > 0 && element.scrollWidth > element.clientWidth;
      const x = event.clientX;
      const y = event.clientY;

      if (hasVerticalScrollbar && x >= rect.right - verticalScrollbarWidth && x <= rect.right) {
        return true;
      }

      if (hasHorizontalScrollbar && y >= rect.bottom - horizontalScrollbarHeight && y <= rect.bottom) {
        return true;
      }

      return false;
    }

    function cancelEdit() {
      state.submittingEdit = false;
      state.submittedEditing = undefined;
      state.pendingEditTarget = undefined;
      state.editing = undefined;
      state.toast = "";
      renderEditor();
    }

    function sendEdit(input) {
      if (state.submittingEdit) {
        return false;
      }

      const parsed = readInputValue(input);
      if (!parsed.ok) {
        input.classList.add("invalid");
        state.toast = parsed.error;
        renderHeaderOnly();
        input.focus();
        return false;
      }

      if (isUnchangedEdit(input, parsed.value)) {
        const pendingEditTarget = state.pendingEditTarget;
        state.submittingEdit = false;
        state.submittedEditing = undefined;
        state.pendingEditTarget = undefined;
        state.editing = undefined;
        state.toast = "";
        renderEditor();
        if (pendingEditTarget) {
          beginEditTarget(pendingEditTarget);
        }
        return true;
      }

      const submittedEditing = {
        lineIndex: Number(input.getAttribute("data-line-index")),
        pathKey: decodeURIComponent(input.getAttribute("data-edit-path")),
        editPath: input.getAttribute("data-edit-path")
      };
      input.classList.remove("invalid");
      state.submittingEdit = true;
      state.submittedEditing = submittedEditing;
      state.editing = undefined;
      state.toast = "";
      vscode.postMessage({
        type: "editValue",
        lineIndex: submittedEditing.lineIndex,
        path: JSON.parse(decodeURIComponent(input.getAttribute("data-edit-path"))),
        value: parsed.value
      });
      return true;
    }

    function isUnchangedEdit(input, nextValue) {
      const originalValueText = input.getAttribute("data-original-value");
      if (originalValueText === null) {
        return false;
      }

      try {
        return JSON.stringify(nextValue) === JSON.stringify(JSON.parse(originalValueText));
      } catch {
        return false;
      }
    }

    function readInputValue(input) {
      const kind = input.getAttribute("data-kind");
      if (kind === "string") {
        return { ok: true, value: input.value };
      }

      if (kind === "number") {
        const value = Number(input.value);
        if (!Number.isFinite(value) || input.value.trim() === "") {
          return { ok: false, error: "Enter a finite number." };
        }
        return { ok: true, value };
      }

      if (kind === "boolean") {
        return { ok: true, value: input.value === "true" };
      }

      if (kind === "null") {
        return { ok: true, value: null };
      }

      return { ok: false, error: "Unsupported value type." };
    }

    function resizeTextareaToContent(textarea) {
      const rows = Math.max(1, textarea.value.split("\\n").length);
      const style = getComputedStyle(textarea);
      const lineHeight = Number.parseFloat(style.lineHeight) || 20;
      const verticalChrome =
        Number.parseFloat(style.borderTopWidth || "0") +
        Number.parseFloat(style.borderBottomWidth || "0") +
        Number.parseFloat(style.paddingTop || "0") +
        Number.parseFloat(style.paddingBottom || "0");
      const baseHeight = rows * lineHeight + verticalChrome;
      textarea.rows = rows;
      textarea.style.height = baseHeight + "px";
      const scrollbarHeight = textarea.scrollWidth > textarea.clientWidth + 1 ? 14 : 0;
      textarea.style.height = (baseHeight + scrollbarHeight) + "px";
    }

    function htmlToText(html) {
      const template = document.createElement("template");
      template.innerHTML = html;
      return template.content.textContent || "";
    }

    function escapeHtml(text) {
      return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
}

function isWebviewMessage(message: unknown): message is WebviewMessage {
  if (!message || typeof message !== "object") {
    return false;
  }

  const candidate = message as {
    type?: unknown;
    lineIndex?: unknown;
    path?: unknown;
    value?: unknown;
  };
  if (candidate.type === "ready") {
    return true;
  }

  if (candidate.type === "selectLine") {
    return Number.isInteger(candidate.lineIndex);
  }

  return (
    candidate.type === "editValue" &&
    Number.isInteger(candidate.lineIndex) &&
    Array.isArray(candidate.path) &&
    isJsonPrimitive(candidate.value)
  );
}

function isJsonPrimitive(value: unknown): value is JsonPrimitive {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isJsonlUri(uri: vscode.Uri): boolean {
  const match = uri.path.toLowerCase().match(/\.[^.\\/]+$/);
  return match ? JSONL_EXTENSIONS.has(match[0]) : false;
}

function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let index = 0; index < 32; index += 1) {
    nonce += chars[Math.floor(Math.random() * chars.length)];
  }
  return nonce;
}
