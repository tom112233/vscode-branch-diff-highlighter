const vscode = require('vscode');
const { exec } = require('child_process');
const path = require('path');

let addedDecoration;
let modifiedDecoration;
let blameDecoration;
let statusBarItem;
let historyOutputChannel;
let currentHunkArgs = null;

const pendingUpdates = new Map();
const fileData = new Map();
const blameCache = new Map();
const baseContentMap = new Map();

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

    // Virtual document provider — serves base-branch content for vscode.diff
    const provider = vscode.workspace.registerTextDocumentContentProvider('branch-diff', {
        provideTextDocumentContent(uri) {
            return baseContentMap.get(uri.toString()) || '';
        }
    });
    context.subscriptions.push(provider);

    context.subscriptions.push(
        vscode.commands.registerCommand('branchDiffHighlighter.revertHunk', revertHunk)
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('branchDiffHighlighter.showBlockHistory', showBlockHistory)
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('branchDiffHighlighter.toggleDiffLayout', () => {
            const cfg = vscode.workspace.getConfiguration('diffEditor');
            const current = cfg.get('renderSideBySide', true);
            cfg.update('renderSideBySide', !current, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(
                `Diff layout: ${!current ? 'side-by-side' : 'inline'}`
            );
        })
    );

    vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) { scheduleUpdate(editor); updateBlame(editor); }
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
    if (!hunk) return;

    const wf = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!wf) return;
    const cwd = wf.uri.fsPath;
    const relPath = path.relative(cwd, editor.document.uri.fsPath);
    const baseBranch = vscode.workspace.getConfiguration('branchDiffHighlighter').get('baseBranch', 'master');
    const filename = path.basename(relPath);

    currentHunkArgs = { cwd, relPath, rawHunk: hunk.rawHunk, startLine: hunk.startLine, endLine: hunk.endLine };

    // Fetch base-branch content and open native diff
    exec(
        `git show "${baseBranch}:${relPath}"`,
        { cwd, maxBuffer: 1024 * 1024 * 10 },
        (err, stdout) => {
            const baseUri = vscode.Uri.parse(`branch-diff:///${relPath.replace(/\\/g, '/')}`);
            baseContentMap.set(baseUri.toString(), stdout || '');

            const selection = new vscode.Range(
                Math.max(0, hunk.startLine - 1), 0,
                Math.max(0, hunk.endLine - 1), 0
            );

            vscode.commands.executeCommand(
                'vscode.diff',
                baseUri,
                editor.document.uri,
                `${baseBranch} ↔ HEAD — ${filename}`,
                { selection, preserveFocus: false }
            ).then(() => {
                // Action buttons in a non-blocking notification
                const isSideBySide = vscode.workspace.getConfiguration('diffEditor').get('renderSideBySide', true);
                vscode.window.showInformationMessage(
                    `Block ${hunk.startLine}–${hunk.endLine} in ${filename}`,
                    '↩ Revert block',
                    '⏱ Show history',
                    isSideBySide ? '⇔ Switch to inline' : '⇔ Switch to split'
                ).then(choice => {
                    if (!choice) return;
                    if (choice.startsWith('↩')) revertHunk(currentHunkArgs);
                    else if (choice.startsWith('⏱')) showBlockHistory(currentHunkArgs);
                    else vscode.commands.executeCommand('branchDiffHighlighter.toggleDiffLayout');
                });
            });
        }
    );
}

async function revertHunk(args) {
    if (!args) args = currentHunkArgs;
    if (!args) return;
    const { cwd, relPath, rawHunk } = args;
    const patch = `diff --git a/${relPath} b/${relPath}\n--- a/${relPath}\n+++ b/${relPath}\n${rawHunk}\n`;
    const child = exec('git apply --reverse --recount', { cwd }, (err, _stdout, stderr) => {
        if (err) { vscode.window.showErrorMessage('Revert failed: ' + (stderr || err.message)); return; }
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            blameCache.delete(editor.document.uri.fsPath);
            scheduleUpdate(editor);
            updateBlame(editor);
        }
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
                if (deletionInBlock) { modified.push(lineNum); } else { added.push(lineNum); }
                hunkEndLine = lineNum;
            } else {
                deletionInBlock = false;
                if (!l.startsWith('\\')) lineNum++;
            }
        }

        hunks.push({ startLine: hunkStartLine, endLine: Math.max(hunkEndLine, hunkStartLine), rawHunk: hunkLines.join('\n') });
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
