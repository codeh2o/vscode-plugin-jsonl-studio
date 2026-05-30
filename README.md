# JSONL Format Preview

Open a `.jsonl` or `.ndjson` file, then click **Open JSONL Format Preview** in the editor title area. The extension opens a side-by-side formatted editor for JSON Lines records.

The preview keeps each JSONL line independent:

- Empty lines are preserved.
- Invalid lines are shown with their parse error and are not edited.
- Strings containing literal `\n` sequences are displayed as real line breaks.
- Strings containing JSON objects or arrays are recursively parsed for editing, then stringified back into the original field when the source buffer is updated.

Editing a value in the preview updates the original VS Code text buffer and marks the document dirty. The extension does not write directly to disk; normal VS Code save behavior remains in control.
