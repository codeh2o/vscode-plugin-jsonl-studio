# Format Preview

Open the **PREVIEW FORMAT** tab in the bottom panel, then copy text anywhere. The panel automatically shows the formatted result.

The extension currently supports two auto-detected formats:

- JSON pretty print
- Markdown/newline preview for escaped `\n` text

The formatter is defensive: malformed JSON, incomplete escapes, and ordinary text fall back to a safe preview instead of throwing.
