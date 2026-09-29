# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0] - 2026-09-29

### Added
- **Hunk diff popup (P0)**: Hover over any changed line to see the full diff hunk in a popup panel
- **Revert block (P1)**: "↩ Revert block" button in the hover panel applies `git apply --reverse` for the hunk only — does not affect other changes
- **Block history (P3)**: "⏱ Show history" button runs `git log -L` for the hunk range and prints to an Output channel
- **Inline blame (P2)**: Cursor line shows `Author · Xh ago` annotation at the end of the line (gray, italic); updates as you move the cursor
- **Status bar stats (P3)**: Bottom status bar shows `+N -N` line change count for the current file relative to base branch

## [0.0.1] - 2026-09-29

### Added
- Highlight added lines (green gutter bar) relative to base branch
- Highlight modified lines (blue gutter bar) relative to base branch
- Overview ruler markers for quick navigation
- Configurable base branch via `branchDiffHighlighter.baseBranch` setting (default: `master`)
- Auto-refresh on file switch and save
