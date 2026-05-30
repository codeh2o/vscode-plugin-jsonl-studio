# Better JSONL Preview

Better JSONL Preview opens `.jsonl` and `.ndjson` files in a side-by-side formatted preview editor. Use the editor title action on a JSONL file to inspect each record as a readable JSON tree while keeping the original text buffer in VS Code.

## Features

- Opens JSONL and NDJSON files beside the source editor.
- Keeps every JSONL line as an independent record.
- Preserves empty lines and invalid lines without rewriting them.
- Displays literal `\n` sequences as real line breaks.
- Recursively expands string values that contain JSON objects or arrays.
- Lets you edit existing string, number, and boolean values from the preview.
- Writes edits back to the original VS Code text buffer and leaves saving to VS Code.
- Syncs preview scrolling with the source JSONL editor.

## Usage

1. Open a `.jsonl` or `.ndjson` file.
2. Click **Open Better JSONL Preview** in the editor title area.
3. Single-click a value in the preview to edit it.
4. Click outside the input to apply the edit, or use Enter for number and boolean edits and Cmd/Ctrl+Enter for string edits. Press Esc to cancel.
5. Save the file normally in VS Code when you are ready.

## Editing Rules

The preview only edits existing values. It does not add or remove keys or array items.

When a string value is recursively parsed as nested JSON, edits inside that nested view are stringified back into the original string field. The extension updates the open VS Code document buffer; it does not write directly to disk.
