import * as vscode from "vscode";
import { formatSelection } from "./formatter";

let besidePanel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("selection-format-preview.openBeside", () => openBeside(context.extensionUri))
  );
}

export function deactivate(): void {
  besidePanel = undefined;
}

function openBeside(extensionUri: vscode.Uri): void {
  if (besidePanel) {
    besidePanel.reveal(vscode.ViewColumn.Beside);
    return;
  }

  besidePanel = vscode.window.createWebviewPanel(
    "selection-format-preview-beside",
    "Clipboard Format Preview",
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      localResourceRoots: [extensionUri],
      retainContextWhenHidden: true
    }
  );

  besidePanel.webview.html = renderPreviewHtml(besidePanel.webview);
  besidePanel.webview.onDidReceiveMessage((message: unknown) => {
    if (besidePanel) {
      handlePreviewMessage(besidePanel.webview, message);
    }
  });
  besidePanel.onDidDispose(() => {
    besidePanel = undefined;
  });
}

async function handlePreviewMessage(webview: vscode.Webview, message: unknown): Promise<void> {
  try {
    if (!isReadClipboardMessage(message)) {
      return;
    }

    const clipboardText = await vscode.env.clipboard.readText();
    const result = formatSelection(clipboardText);
    webview.postMessage({
      type: "clipboardFormatted",
      source: clipboardText,
      kind: result.kind,
      text: result.formatted,
      warning: result.warning ?? ""
    });
  } catch (error) {
    webview.postMessage({
      type: "clipboardFormatted",
      source: "",
      kind: "markdown",
      text: "",
      warning: `Preview fallback: ${error instanceof Error ? error.message : "unknown error"}`
    });
  }
}

function renderPreviewHtml(webview: vscode.Webview): string {
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
  <title>Clipboard Format Preview</title>
  <style>
    :root {
      color-scheme: light dark;
      --pf-key: #0451a5;
      --pf-string: #a31515;
      --pf-number: #098658;
      --pf-literal: #0000ff;
      --pf-null: #795e26;
      --pf-muted: var(--vscode-descriptionForeground);
      --pf-line: var(--vscode-editorIndentGuide-background);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: 1.45;
    }

    .root {
      width: 100vw;
      height: 100vh;
      overflow: auto;
      padding: 10px 12px 24px;
    }

    .empty {
      color: var(--pf-muted);
      font-family: var(--vscode-font-family);
      padding: 6px 2px;
    }

    .plain {
      margin: 0;
      white-space: pre;
    }

    .tree {
      min-width: max-content;
      white-space: nowrap;
    }

    details {
      margin: 0;
      padding: 0;
    }

    summary {
      min-height: 1.45em;
      cursor: pointer;
      outline: none;
    }

    summary::marker {
      color: var(--pf-muted);
    }

    .children {
      margin-left: 18px;
      padding-left: 12px;
      border-left: 1px solid var(--pf-line);
    }

    .row {
      min-height: 1.45em;
    }

    .key {
      color: var(--pf-key);
    }

    .string {
      color: var(--pf-string);
    }

    .number {
      color: var(--pf-number);
    }

    .literal {
      color: var(--pf-literal);
    }

    .null {
      color: var(--pf-null);
    }

    .meta {
      color: var(--pf-muted);
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --pf-key: #9cdcfe;
        --pf-string: #ce9178;
        --pf-number: #b5cea8;
        --pf-literal: #569cd6;
        --pf-null: #c586c0;
      }
    }
  </style>
</head>
<body>
  <main id="root" class="root" aria-live="polite">
    <div class="empty">Copy JSON or escaped text to preview it here.</div>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const root = document.getElementById("root");

    let lastClipboardSource = "";
    let timer = undefined;

    function requestClipboard() {
      vscode.postMessage({ type: "readClipboard" });
    }

    function render(message) {
      const text = message.text || "";
      if (!text) {
        root.innerHTML = '<div class="empty">Copy JSON or escaped text to preview it here.</div>';
        return;
      }

      if (message.kind === "json") {
        try {
          root.innerHTML = '<div class="tree">' + renderJsonValue(JSON.parse(text), undefined, 0) + '</div>';
          return;
        } catch {
          renderPlain(text);
          return;
        }
      }

      renderPlain(text);
    }

    function renderPlain(text) {
      root.innerHTML = "";
      const pre = document.createElement("pre");
      pre.className = "plain";
      pre.textContent = text;
      root.appendChild(pre);
    }

    function renderJsonValue(value, key, depth) {
      if (Array.isArray(value)) {
        return renderCollection(value.map((item, index) => [String(index), item]), key, depth, "[", "]", value.length + " items", true);
      }

      if (value && typeof value === "object") {
        const entries = Object.entries(value);
        return renderCollection(entries, key, depth, "{", "}", entries.length + " keys", false);
      }

      return '<div class="row">' + renderKey(key) + renderPrimitive(value) + '</div>';
    }

    function renderCollection(entries, key, depth, open, close, meta, isArray) {
      const children = entries.map(([childKey, childValue]) => {
        return renderJsonValue(childValue, isArray ? undefined : childKey, depth + 1);
      }).join("");

      return '<details open>' +
        '<summary>' + renderKey(key) + '<span class="meta">' + open + ' ' + escapeHtml(meta) + ' ' + close + '</span></summary>' +
        '<div class="children">' + children + '</div>' +
      '</details>';
    }

    function renderKey(key) {
      if (key === undefined) {
        return "";
      }
      return '<span class="key">"' + escapeHtml(key) + '"</span>: ';
    }

    function renderPrimitive(value) {
      if (typeof value === "string") {
        return '<span class="string">"' + escapeHtml(value) + '"</span>';
      }
      if (typeof value === "number") {
        return '<span class="number">' + String(value) + '</span>';
      }
      if (typeof value === "boolean") {
        return '<span class="literal">' + String(value) + '</span>';
      }
      if (value === null) {
        return '<span class="null">null</span>';
      }
      return '<span>' + escapeHtml(String(value)) + '</span>';
    }

    function escapeHtml(text) {
      return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (!message || message.type !== "clipboardFormatted") {
        return;
      }

      const source = message.source || "";
      if (source && source !== lastClipboardSource) {
        lastClipboardSource = source;
        render(message);
      }
    });

    requestClipboard();
    timer = window.setInterval(requestClipboard, 800);
    window.addEventListener("focus", requestClipboard);
    window.addEventListener("pagehide", () => window.clearInterval(timer));
  </script>
</body>
</html>`;
}

interface ReadClipboardMessage {
  type: "readClipboard";
}

function isReadClipboardMessage(message: unknown): message is ReadClipboardMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "readClipboard"
  );
}

function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let index = 0; index < 32; index += 1) {
    nonce += chars[Math.floor(Math.random() * chars.length)];
  }
  return nonce;
}
