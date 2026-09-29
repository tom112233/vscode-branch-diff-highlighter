# Branch Diff Highlighter

> Highlights lines changed relative to a base branch directly in the editor gutter — like GoLand's branch diff coloring, for VSCode.

## Features

### Gutter color bars
When you open a file, the extension compares it against your configured base branch using `git diff` and marks every changed line in the gutter:

- **Green bar** — line was added in this branch
- **Blue bar** — line was modified in this branch (replaces existing content)

Changes are also reflected in the **Overview Ruler** (the minimap scrollbar on the right).

### Hunk diff popup
Hover over any changed line to see the full diff hunk in a floating panel. The popup shows the before/after context for the entire contiguous block.

### Revert block
Inside the hover panel, click **↩ Revert block** to undo just that hunk using `git apply --reverse`. Only the hovered block is reverted — other changes in the file are untouched.

### Block history
Click **⏱ Show history** in the hover panel to run `git log -L` for the hunk's line range. Output appears in the **Branch Diff: Block History** output channel.

### Inline blame
The last author and relative time (e.g. `coconutMilk · 2h ago`) are shown at the end of the cursor line in gray italic. The annotation follows your cursor and only appears on the active line, similar to GitLens' current-line blame.

### Status bar stats
The bottom status bar shows `+N -N` — the total added and deleted line count for the current file relative to the base branch.

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

Open any file tracked by Git. If the file has lines that differ from the base branch, colored bars appear immediately in the left gutter. Hover over a bar to see the diff popup with revert and history actions.

## Known Issues

- Deleted-only blocks (no added lines) are not annotated in the gutter.
- Binary files are skipped silently.
- Very large diffs (>10 MB) may be slow on first open.

## Release Notes

See [CHANGELOG.md](CHANGELOG.md).

## Contributing

Pull requests are welcome. Please open an issue first if you're planning a larger change.

## License

MIT
