# Branch Diff Highlighter

> Highlights lines changed relative to a base branch directly in the editor gutter — like GoLand's branch diff coloring, for VSCode.

## Features

When you open a file, the extension compares it against your configured base branch using `git diff` and marks every changed line in the gutter:

- **Green bar** — line was added in this branch
- **Blue bar** — line was modified in this branch (replaces existing content)

Changes are also reflected in the **Overview Ruler** (the minimap scrollbar on the right) so you can spot modified regions at a glance without scrolling.

The decoration refreshes automatically when you:
- Switch to a different file
- Save the current file

## Requirements

- Git must be installed and available on `PATH`
- The workspace must be inside a Git repository
- The base branch (default: `master`) must exist locally

## Installation

### From source (manual)

1. Clone or download this repository
2. Copy the folder into your VSCode extensions directory:

   ```bash
   # macOS / Linux
   cp -r vscode-branch-diff-highlighter ~/.vscode/extensions/local.branch-diff-highlighter-0.0.1

   # Windows
   xcopy vscode-branch-diff-highlighter %USERPROFILE%\.vscode\extensions\local.branch-diff-highlighter-0.0.1 /E
   ```

3. Reload VSCode (`Cmd+Shift+P` → `Developer: Reload Window`)

> VSIX packaging and Marketplace publishing are not yet set up. Contributions welcome.

## Extension Settings

| Setting | Default | Description |
|---|---|---|
| `branchDiffHighlighter.baseBranch` | `"master"` | The branch to diff against |

**Example** — diff against `main` instead:

```json
{
  "branchDiffHighlighter.baseBranch": "main"
}
```

## Usage

Open any file tracked by Git. If the file has lines that differ from the base branch, colored bars appear immediately in the left gutter. No command needed.

To change the base branch mid-session, update `branchDiffHighlighter.baseBranch` in your workspace settings and switch to another file (or save the current one) to trigger a refresh.

## Known Issues

- Deleted lines are not marked (only the surrounding context shows modification bars). This matches how `git diff` hunk headers work — deleted-only blocks leave no `+` lines to annotate.
- Binary files are skipped silently.
- Very large diffs (>10 MB) may be slow on first open.

## Release Notes

### 0.0.1

Initial release. Adds/modified line highlighting in the editor gutter relative to a configurable base branch.

## Contributing

Pull requests are welcome. Please open an issue first if you're planning a larger change.

## License

MIT
