# Clipboard Format Preview

Copy text anywhere, then click **Open Clipboard Format Preview** in the editor title area. The right-side preview updates from the clipboard and renders JSON as an expandable tree.

The extension currently supports two auto-detected formats:

- JSON pretty print
- Markdown/newline preview for escaped `\n` text

The formatter is defensive: malformed JSON, incomplete escapes, and ordinary text fall back to a safe preview instead of throwing.
