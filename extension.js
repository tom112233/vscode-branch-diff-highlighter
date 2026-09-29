const vscode = require('vscode');
const { exec } = require('child_process');
const path = require('path');

let addedDecoration;
let modifiedDecoration;
let blameDecoration;
let statusBarItem;
let historyOutputChannel;
let diffPanel = null;
let currentHunkArgs = null;

const pendingUpdates = new Map();
const fileData = new Map();
const blameCache = new Map();

function activate(context) {
    addedDecoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        overviewRulerLane: vscode.OverviewRulerLane.Left,
        overviewRulerColor: '#4EC9B0',
        backgroundColor: 'rgba(78, 201, 176, 0.07)',
        borderWidth: '0 0 0 3px',
        borderStyle: 'solid',
        borderColor: '#4EC9B0',
    });

    modifiedDecoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        overviewRulerLane: vscode.OverviewRulerLane.Left,
        overviewRulerColor: '#569CD6',
        backgroundColor: 'rgba(86, 156, 214, 0.07)',
        borderWidth: '0 0 0 3px',
        borderStyle: 'solid',
        borderColor: '#569CD6',
    });

    blameDecoration = vscode.window.createTextEditorDecorationType({
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
    });

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.tooltip = 'Lines changed in this branch vs base';
    context.subscriptions.push(statusBarItem);

    historyOutputChannel = vscode.window.createOutputChannel('Branch Diff: Block History');
    context.subscriptions.push(historyOutputChannel);

    context.subscriptions.push(
        vscode.commands.registerCommand('branchDiffHighlighter.revertHunk', revertHunk)
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('branchDiffHighlighter.showBlockHistory', showBlockHistory)
    );

    vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) {
            scheduleUpdate(editor);
            updateBlame(editor);
        }
    }, null, context.subscriptions);

    vscode.workspace.onDidSaveTextDocument(doc => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document === doc) {
            blameCache.delete(doc.uri.fsPath);
            scheduleUpdate(editor);
            updateBlame(editor);
        }
    }, null, context.subscriptions);

    vscode.window.onDidChangeTextEditorSelection(e => {
        updateBlameDecoration(e.textEditor);
        // only react to mouse clicks, not keyboard navigation
        if (e.kind === vscode.TextEditorSelectionChangeKind.Mouse) {
            handleMouseClick(e.textEditor);
        }
    }, null, context.subscriptions);

    if (vscode.window.activeTextEditor) {
        scheduleUpdate(vscode.window.activeTextEditor);
        updateBlame(vscode.window.activeTextEditor);
    }
}

function handleMouseClick(editor) {
    const data = fileData.get(editor.document.uri.fsPath);
    const lineNum = editor.selection.active.line + 1;
    const hunk = data && data.hunks.find(h => lineNum >= h.startLine && lineNum <= h.endLine);

    if (!hunk) {
        if (diffPanel) { diffPanel.dispose(); diffPanel = null; }
        return;
    }

    const wf = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!wf) return;
    const cwd = wf.uri.fsPath;
    const relPath = path.relative(cwd, editor.document.uri.fsPath);
    const baseBranch = vscode.workspace.getConfiguration('branchDiffHighlighter').get('baseBranch', 'master');

    currentHunkArgs = { cwd, relPath, rawHunk: hunk.rawHunk, startLine: hunk.startLine, endLine: hunk.endLine };

    const filename = path.basename(relPath);
    const html = buildDiffHtml(hunk, filename, baseBranch, relPath);

    if (!diffPanel) {
        diffPanel = vscode.window.createWebviewPanel(
            'branchDiffHighlighter.diff',
            `Diff: ${filename}`,
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: true, retainContextWhenHidden: true }
        );
        diffPanel.webview.onDidReceiveMessage(msg => {
            if (msg.command === 'revert') revertHunk(currentHunkArgs);
            else if (msg.command === 'history') showBlockHistory(currentHunkArgs);
        });
        diffPanel.onDidDispose(() => { diffPanel = null; });
    }

    diffPanel.title = `Diff: ${filename}`;
    diffPanel.webview.html = html;
    diffPanel.reveal(vscode.ViewColumn.Beside, true);
}

function buildDiffHtml(hunk, filename, baseBranch, relPath) {
    const lines = hunk.rawHunk.split('\n');
    const hunkHeader = escapeHtml(lines[0] || '');

    const diffRows = lines.slice(1).map(l => {
        if (l === '') return '';
        const ch = l[0];
        if (ch === '+') {
            return `<div class="line added"><span class="sign">+</span><span class="content">${escapeHtml(l.slice(1))}</span></div>`;
        } else if (ch === '-') {
            return `<div class="line removed"><span class="sign">-</span><span class="content">${escapeHtml(l.slice(1))}</span></div>`;
        } else if (ch === '\\') {
            return '';
        }
        return `<div class="line context"><span class="sign"> </span><span class="content">${escapeHtml(l.slice(1))}</span></div>`;
    }).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0;
    font-family: var(--vscode-editor-font-family, 'Menlo', 'Monaco', monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    line-height: 1.5;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    overflow-x: hidden;
  }
  .toolbar {
    position: sticky; top: 0; z-index: 100;
    background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
    padding: 7px 12px;
    display: flex; align-items: center; gap: 8px;
  }
  .toolbar-meta {
    flex: 1;
    display: flex; flex-direction: column; gap: 1px;
    min-width: 0;
  }
  .toolbar-title {
    font-weight: 600;
    font-size: 0.82em;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    color: var(--vscode-foreground);
  }
  .toolbar-subtitle {
    font-size: 0.75em;
    opacity: 0.55;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    font-style: italic;
  }
  .btn {
    flex-shrink: 0;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; padding: 4px 11px;
    border-radius: 3px; cursor: pointer;
    font-size: 0.82em; font-family: inherit;
    white-space: nowrap;
  }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
  .btn-secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .diff { overflow-x: auto; padding: 4px 0; }
  .branch-label {
    display: flex; gap: 0;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
    margin-bottom: 2px;
  }
  .branch-tag {
    flex: 1; text-align: center;
    font-size: 0.75em; font-weight: 600; padding: 3px 0;
    opacity: 0.55;
    letter-spacing: 0.05em;
  }
  .branch-tag.before { color: #e5534b; border-right: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); }
  .branch-tag.after { color: #4EC9B0; }
  .line {
    display: flex; padding: 0;
    min-width: max-content;
  }
  .line.added { background: rgba(78, 201, 176, 0.13); }
  .line.removed { background: rgba(229, 83, 75, 0.15); }
  .line.context { opacity: 0.75; }
  .sign {
    width: 22px; text-align: center;
    flex-shrink: 0; user-select: none;
    font-weight: 700; font-size: 0.9em;
    padding: 1px 0;
  }
  .line.added .sign { color: #4EC9B0; }
  .line.removed .sign { color: #e5534b; }
  .content {
    flex: 1; padding: 1px 12px 1px 4px;
    white-space: pre;
  }
</style>
</head>
<body>
<div class="toolbar">
  <div class="toolbar-meta">
    <div class="toolbar-title">${escapeHtml(filename)}</div>
    <div class="toolbar-subtitle">${escapeHtml(baseBranch)}...HEAD &nbsp;·&nbsp; ${escapeHtml(hunkHeader)}</div>
  </div>
  <button class="btn btn-secondary" onclick="history()">⏱ History</button>
  <button class="btn" onclick="revert()">↩ Revert</button>
</div>
<div class="diff">
  <div class="branch-label">
    <span class="branch-tag before">− ${escapeHtml(baseBranch)}</span>
    <span class="branch-tag after">+ HEAD</span>
  </div>
  ${diffRows}
</div>
<script>
  const vscode = acquireVsCodeApi();
  function revert() { vscode.postMessage({ command: 'revert' }); }
  function history() { vscode.postMessage({ command: 'history' }); }
</script>
</body>
</html>`;
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

async function revertHunk(args) {
    if (!args) args = currentHunkArgs;
    if (!args) return;
    const { cwd, relPath, rawHunk } = args;
    const patch = `diff --git a/${relPath} b/${relPath}\n--- a/${relPath}\n+++ b/${relPath}\n${rawHunk}\n`;
    const child = exec('git apply --reverse --recount', { cwd }, (err, _stdout, stderr) => {
        if (err) {
            vscode.window.showErrorMessage('Revert failed: ' + (stderr || err.message));
            return;
        }
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            blameCache.delete(editor.document.uri.fsPath);
            scheduleUpdate(editor);
            updateBlame(editor);
        }
        if (diffPanel) { diffPanel.dispose(); diffPanel = null; }
        vscode.window.showInformationMessage('Block reverted.');
    });
    child.stdin.end(patch);
}

function showBlockHistory(args) {
    if (!args) args = currentHunkArgs;
    if (!args) return;
    const { cwd, relPath, startLine, endLine } = args;
    exec(
        `git log --oneline -L ${startLine},${endLine}:"${relPath}"`,
        { cwd, maxBuffer: 1024 * 1024 * 5 },
        (err, stdout, stderr) => {
            historyOutputChannel.clear();
            historyOutputChannel.appendLine(`History for ${relPath}:${startLine}-${endLine}`);
            historyOutputChannel.appendLine('');
            historyOutputChannel.append(stdout || stderr || 'No history found.');
            historyOutputChannel.show(true);
        }
    );
}

function scheduleUpdate(editor) {
    const key = editor.document.uri.fsPath;
    if (pendingUpdates.has(key)) clearTimeout(pendingUpdates.get(key));
    pendingUpdates.set(key, setTimeout(() => {
        pendingUpdates.delete(key);
        updateDecorations(editor);
    }, 200));
}

function updateDecorations(editor) {
    const filePath = editor.document.uri.fsPath;
    const wf = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!wf) return;

    const cwd = wf.uri.fsPath;
    const baseBranch = vscode.workspace.getConfiguration('branchDiffHighlighter').get('baseBranch', 'master');
    const relPath = path.relative(cwd, filePath);

    exec(
        `git diff "${baseBranch}...HEAD" -- "${relPath}"`,
        { cwd, maxBuffer: 1024 * 1024 * 10 },
        (err, stdout) => {
            if (err || !stdout) {
                fileData.delete(filePath);
                editor.setDecorations(addedDecoration, []);
                editor.setDecorations(modifiedDecoration, []);
                statusBarItem.hide();
                return;
            }
            const parsed = parseDiff(stdout);
            fileData.set(filePath, parsed);
            editor.setDecorations(addedDecoration, parsed.added.map(n => new vscode.Range(n - 1, 0, n - 1, 0)));
            editor.setDecorations(modifiedDecoration, parsed.modified.map(n => new vscode.Range(n - 1, 0, n - 1, 0)));
            statusBarItem.text = `$(diff) +${parsed.addedCount} -${parsed.deletedCount}`;
            statusBarItem.show();
        }
    );
}

function parseDiff(diffOutput) {
    const hunks = [];
    const added = [];
    const modified = [];
    let addedCount = 0;
    let deletedCount = 0;
    const lines = diffOutput.split('\n');
    let i = 0;

    while (i < lines.length) {
        if (!lines[i].startsWith('@@')) { i++; continue; }
        const header = lines[i];
        const m = header.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (!m) { i++; continue; }
        const newStart = parseInt(m[2]);
        i++;

        const hunkLines = [header];
        while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff ')) {
            hunkLines.push(lines[i]);
            i++;
        }

        let lineNum = newStart - 1;
        let deletionInBlock = false;
        let hunkStartLine = newStart;
        let hunkEndLine = newStart;

        for (const l of hunkLines.slice(1)) {
            if (l.startsWith('-')) {
                deletionInBlock = true;
                deletedCount++;
            } else if (l.startsWith('+')) {
                lineNum++;
                addedCount++;
                if (deletionInBlock) {
                    modified.push(lineNum);
                } else {
                    added.push(lineNum);
                }
                hunkEndLine = lineNum;
            } else {
                deletionInBlock = false;
                if (!l.startsWith('\\')) lineNum++;
            }
        }

        hunks.push({
            startLine: hunkStartLine,
            endLine: Math.max(hunkEndLine, hunkStartLine),
            rawHunk: hunkLines.join('\n'),
        });
    }

    return { hunks, added, modified, addedCount, deletedCount };
}

function updateBlame(editor) {
    const filePath = editor.document.uri.fsPath;
    if (blameCache.has(filePath)) { updateBlameDecoration(editor); return; }
    const wf = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!wf) return;
    const cwd = wf.uri.fsPath;
    const relPath = path.relative(cwd, filePath);
    exec(
        `git blame --line-porcelain -- "${relPath}"`,
        { cwd, maxBuffer: 1024 * 1024 * 20 },
        (err, stdout) => {
            if (err || !stdout) return;
            blameCache.set(filePath, parseBlame(stdout));
            updateBlameDecoration(editor);
        }
    );
}

function parseBlame(output) {
    const result = [null];
    const lines = output.split('\n');
    const now = Date.now() / 1000;
    let i = 0;
    while (i < lines.length) {
        if (!/^[0-9a-f]{40} /.test(lines[i])) { i++; continue; }
        let author = '', authorTime = 0;
        i++;
        while (i < lines.length && !lines[i].startsWith('\t')) {
            if (lines[i].startsWith('author ')) author = lines[i].slice(7);
            else if (lines[i].startsWith('author-time ')) authorTime = parseInt(lines[i].slice(12));
            i++;
        }
        i++;
        result.push({ author, relTime: relativeTime(now - authorTime) });
    }
    return result;
}

function relativeTime(sec) {
    if (sec < 60) return 'just now';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
    if (sec < 2592000) return Math.floor(sec / 86400) + 'd ago';
    if (sec < 31536000) return Math.floor(sec / 2592000) + 'mo ago';
    return Math.floor(sec / 31536000) + 'y ago';
}

function updateBlameDecoration(editor) {
    const blame = blameCache.get(editor.document.uri.fsPath);
    if (!blame) { editor.setDecorations(blameDecoration, []); return; }
    const cursorLine = editor.selection.active.line;
    const entry = blame[cursorLine + 1];
    if (!entry) { editor.setDecorations(blameDecoration, []); return; }
    editor.setDecorations(blameDecoration, [{
        range: new vscode.Range(cursorLine, Number.MAX_SAFE_INTEGER, cursorLine, Number.MAX_SAFE_INTEGER),
        renderOptions: {
            after: {
                contentText: `  ${entry.author} · ${entry.relTime}`,
                color: new vscode.ThemeColor('editorCodeLens.foreground'),
                fontStyle: 'italic',
            }
        }
    }]);
}

function deactivate() {}

module.exports = { activate, deactivate };
