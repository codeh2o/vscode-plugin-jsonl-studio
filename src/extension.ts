import * as vscode from "vscode";
import { formatSelection } from "./formatter";

const VIEW_ID = "selection-format-preview-format-view";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, new FormatViewProvider(context.extensionUri), {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    })
  );
}

export function deactivate(): void {
  // Nothing to clean up.
}

class FormatViewProvider implements vscode.WebviewViewProvider {
  public constructor(private readonly extensionUri: vscode.Uri) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    webview.html = this.renderHtml(webview);

    webview.onDidReceiveMessage(async (message: unknown) => {
      try {
        if (isReadClipboardMessage(message)) {
          const clipboardText = await vscode.env.clipboard.readText();
          const result = formatSelection(clipboardText);
          webview.postMessage({
            type: "clipboardFormatted",
            source: clipboardText,
            kind: result.kind,
            text: result.formatted,
            warning: result.warning ?? ""
          });
          return;
        }

        if (!isFormatMessage(message)) {
          return;
        }

        const result = formatSelection(message.text);
        webview.postMessage({
          type: "formatted",
          kind: result.kind,
          text: result.formatted,
          warning: result.warning ?? ""
        });
      } catch (error) {
        webview.postMessage({
          type: "formatted",
          kind: "markdown",
          text: isFormatMessage(message) ? message.text : "",
          warning: `Preview fallback: ${error instanceof Error ? error.message : "unknown error"}`
        });
      }
    });
  }

  private renderHtml(webview: vscode.Webview): string {
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
  <title>Format</title>
  <style>
    :root {
      color-scheme: light dark;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      padding: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }

    pre {
      width: 100%;
      height: 100vh;
      margin: 0;
      padding: 14px 16px;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      border: 0;
      outline: 0;
      overflow: auto;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: 1.45;
      white-space: pre;
    }
  </style>
</head>
<body>
  <pre id="output" aria-live="polite"></pre>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const output = document.getElementById("output");

    let lastClipboardSource = "";
    let clipboardTimer = undefined;

    function requestClipboard() {
      vscode.postMessage({ type: "readClipboard" });
    }

    function applyFormatted(message) {
      output.textContent = message.text || "";
    }

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (!message) {
        return;
      }

      if (message.type === "clipboardFormatted") {
        const source = message.source || "";
        if (source && source !== lastClipboardSource) {
          lastClipboardSource = source;
          applyFormatted(message);
        }
        return;
      }

      if (message.type === "formatted") {
        applyFormatted(message);
      }
    });

    requestClipboard();
    clipboardTimer = window.setInterval(requestClipboard, 800);
    window.addEventListener("focus", requestClipboard);
    window.addEventListener("pagehide", () => window.clearInterval(clipboardTimer));
  </script>
</body>
</html>`;
  }
}

interface FormatMessage {
  type: "format";
  text: string;
}

interface ReadClipboardMessage {
  type: "readClipboard";
}

function isFormatMessage(message: unknown): message is FormatMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "format" &&
    typeof (message as { text?: unknown }).text === "string"
  );
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
