# JSONL Studio

JSONL Studio opens `.jsonl` and `.ndjson` files in a side-by-side formatted editor. Use the editor title action on a JSONL file to inspect each record as a readable JSON tree while keeping the original text buffer in VS Code.

## Screenshots

![JSONL Studio formatted preview](https://github.com/codeh2o/vscode-plugin-jsonl-studio/blob/main/guides/tutorio1.png?raw=true)

![JSONL Studio nested editing](https://github.com/codeh2o/vscode-plugin-jsonl-studio/blob/main/guides/tutorio2.png?raw=true)

## Features

- Opens JSONL and NDJSON files beside the source editor.
- Keeps every JSONL line as an independent record.
- Preserves empty lines and invalid lines without rewriting them.
- Displays literal `\n` sequences as real line breaks.
- Recursively expands string values that contain JSON objects or arrays.
- Lets you edit existing string, number, and boolean values from the preview.
- Writes edits back to the original VS Code text buffer and leaves saving to VS Code.
- Syncs preview scrolling with the source JSONL editor.
- Includes an in-preview find widget with case-sensitive, whole-word, and regular-expression modes.

## Usage

1. Open a `.jsonl` or `.ndjson` file.
2. Click **Open JSONL Studio** in the editor title area.
3. Single-click a value in the preview to edit it.
4. Click outside the input to apply the edit, or use Enter for number and boolean edits and Cmd/Ctrl+Enter for string edits. Press Esc to cancel.
5. Save the file normally in VS Code when you are ready.

## Editing Rules

The preview only edits existing values. It does not add or remove keys or array items.

When a string value is recursively parsed as nested JSON, edits inside that nested view are stringified back into the original string field. The extension updates the open VS Code document buffer; it does not write directly to disk.

## Repository and Feedback

Repository: [codeh2o/vscode-plugin-jsonl-studio](https://github.com/codeh2o/vscode-plugin-jsonl-studio)

If you find a bug, please open an issue in the repository.

---

# JSONL Studio 中文说明

JSONL Studio 可以在 VS Code 中以左右分栏的方式打开 `.jsonl` 和 `.ndjson` 文件。你可以在保持原始文本缓冲区不变的同时，把每一行 JSONL 记录查看成更易读的 JSON 树，并直接编辑已有值。

## 截图展示

![JSONL Studio 格式化预览](https://github.com/codeh2o/vscode-plugin-jsonl-studio/blob/main/guides/tutorio1.png?raw=true)

![JSONL Studio 嵌套编辑](https://github.com/codeh2o/vscode-plugin-jsonl-studio/blob/main/guides/tutorio2.png?raw=true)

## 功能

- 在源编辑器旁边打开 JSONL 和 NDJSON 格式化视图。
- 将每一行 JSONL 作为独立记录处理。
- 保留空行和无效行，不会擅自重写文件。
- 将字符串中的字面量 `\n` 显示为真实换行。
- 递归展开包含 JSON 对象或数组的字符串值。
- 支持从预览里编辑已有的字符串、数字和布尔值。
- 将编辑写回 VS Code 中已打开的文本缓冲区，是否保存仍由你决定。
- 预览滚动会与源 JSONL 编辑器同步。
- 内置查找控件，支持大小写匹配、全词匹配和正则搜索。

## 使用方法

1. 打开一个 `.jsonl` 或 `.ndjson` 文件。
2. 点击编辑器标题区域的 **Open JSONL Studio**。
3. 在预览中单击某个值即可编辑。
4. 点击输入框外应用编辑；数字和布尔值可按 Enter 应用，字符串可按 Cmd/Ctrl+Enter 应用，按 Esc 取消。
5. 准备好后，像平时一样在 VS Code 中保存文件。

## 编辑规则

预览只编辑已有值，不会新增或删除 key，也不会新增或删除数组项。

当某个字符串值被递归解析为嵌套 JSON 时，在嵌套视图里的编辑会重新序列化回原始字符串字段。扩展只更新 VS Code 中打开的文档缓冲区，不会绕过 VS Code 直接写入磁盘。

## 仓库与反馈

仓库地址：[codeh2o/vscode-plugin-jsonl-studio](https://github.com/codeh2o/vscode-plugin-jsonl-studio)

如果发现 bug，请到仓库提交 issue。
