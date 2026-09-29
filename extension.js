const vscode = require('vscode');
const { exec } = require('child_process');
const path = require('path');

let addedDecoration;
let modifiedDecoration;
let blameDecoration;
let statusBarItem;
let historyOutputChannel;

const pendingUpdates = new Map();
const fileData = new Map();   // filePath → { hunks, added, modified }
const blameCache = new Map(); // filePath → [{author, relTime}] (1-indexed, index 0 unused)

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

    // P2: blame decoration — per-range renderOptions supply the actual text
    blameDecoration = vscode.window.createTextEditorDecorationType({
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
    });

    // P3: status bar
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.tooltip = 'Lines changed in this branch vs base';
    context.subscriptions.push(statusBarItem);

    historyOutputChannel = vscode.window.createOutputChannel('Branch Diff: Block History');
    context.subscriptions.push(historyOutputChannel);

    // P1: revert hunk command
    context.subscriptions.push(
        vscode.commands.registerCommand('branchDiffHighlighter.revertHunk', async (args) => {
            const { cwd, relPath, rawHunk } = args;
            const patch = `diff --git a/${relPath} b/${relPath}\n--- a/${relPath}\n+++ b/${relPath}\n${rawHunk}\n`;
            exec('git apply --reverse --recount', { cwd }, (err, _stdout, stderr) => {
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
                vscode.window.showInformationMessage('Block reverted.');
            }).stdin.end(patch);
        })
    );

    // P3: show block history command
    context.subscriptions.push(
        vscode.commands.registerCommand('branchDiffHighlighter.showBlockHistory', (args) => {
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
        })
    );

    // P0: hover provider — shows hunk diff + Revert + History buttons
    context.subscriptions.push(
        vscode.languages.registerHoverProvider({ scheme: 'file' }, {
            provideHover(document, position) {
                const data = fileData.get(document.uri.fsPath);
                if (!data) return;
                const lineNum = position.line + 1; // 1-indexed
                const hunk = data.hunks.find(h => lineNum >= h.startLine && lineNum <= h.endLine);
                if (!hunk) return;

                const wf = vscode.workspace.getWorkspaceFolder(document.uri);
                if (!wf) return;
                const cwd = wf.uri.fsPath;
                const relPath = path.relative(cwd, document.uri.fsPath);

                const md = new vscode.MarkdownString();
                md.isTrusted = true;
                md.supportHtml = false;

                // Render diff hunk
                const diffLines = hunk.rawHunk.split('\n').map(l => {
                    if (l.startsWith('+')) return '+ ' + l.slice(1);
                    if (l.startsWith('-')) return '- ' + l.slice(1);
                    return '  ' + l.slice(1);
                }).join('\n');
                md.appendCodeblock(diffLines, 'diff');

                // Revert button
                const revertArgs = encodeURIComponent(JSON.stringify({ cwd, relPath, rawHunk: hunk.rawHunk }));
                md.appendMarkdown(`[↩ Revert block](command:branchDiffHighlighter.revertHunk?${revertArgs})`);
                md.appendMarkdown('  ');

                // History button
                const histArgs = encodeURIComponent(JSON.stringify({ cwd, relPath, startLine: hunk.startLine, endLine: hunk.endLine }));
                md.appendMarkdown(`[⏱ Show history](command:branchDiffHighlighter.showBlockHistory?${histArgs})`);

                return new vscode.Hover(md);
            }
        })
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

    // P2: update blame decoration on cursor move
    vscode.window.onDidChangeTextEditorSelection(e => {
        updateBlameDecoration(e.textEditor);
    }, null, context.subscriptions);

    if (vscode.window.activeTextEditor) {
        scheduleUpdate(vscode.window.activeTextEditor);
        updateBlame(vscode.window.activeTextEditor);
    }
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

            // P3: status bar
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
        const m = header.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (!m) { i++; continue; }

        const newStart = parseInt(m[3]);
        i++;

        // Collect raw hunk lines (including @@ header)
        const hunkLines = [header];
        while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff ')) {
            hunkLines.push(lines[i]);
            i++;
        }

        // Classify lines and track line numbers
        let lineNum = newStart - 1;
        let deletionInBlock = false;
        let hunkStartLine = newStart;
        let hunkEndLine = newStart;

        for (const l of hunkLines.slice(1)) { // skip @@ line
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

// P2: git blame
function updateBlame(editor) {
    const filePath = editor.document.uri.fsPath;
    if (blameCache.has(filePath)) {
        updateBlameDecoration(editor);
        return;
    }

    const wf = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!wf) return;
    const cwd = wf.uri.fsPath;
    const relPath = path.relative(cwd, filePath);

    exec(
        `git blame --line-porcelain -- "${relPath}"`,
        { cwd, maxBuffer: 1024 * 1024 * 20 },
        (err, stdout) => {
            if (err || !stdout) return;
            const blame = parseBlame(stdout);
            blameCache.set(filePath, blame);
            updateBlameDecoration(editor);
        }
    );
}

function parseBlame(output) {
    // Returns array where index = line number (1-indexed, index 0 is null)
    const result = [null];
    const lines = output.split('\n');
    let i = 0;
    const now = Date.now() / 1000;

    while (i < lines.length) {
        // header line: <sha> <orig> <final> [<count>]
        if (!/^[0-9a-f]{40} /.test(lines[i])) { i++; continue; }

        let author = '';
        let authorTime = 0;
        i++;

        while (i < lines.length && !lines[i].startsWith('\t')) {
            if (lines[i].startsWith('author ')) author = lines[i].slice(7);
            else if (lines[i].startsWith('author-time ')) authorTime = parseInt(lines[i].slice(12));
            i++;
        }
        i++; // skip the \t content line

        const relTime = relativeTime(now - authorTime);
        result.push({ author, relTime });
    }

    return result;
}

function relativeTime(seconds) {
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
    if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
    if (seconds < 2592000) return Math.floor(seconds / 86400) + 'd ago';
    if (seconds < 31536000) return Math.floor(seconds / 2592000) + 'mo ago';
    return Math.floor(seconds / 31536000) + 'y ago';
}

function updateBlameDecoration(editor) {
    const blame = blameCache.get(editor.document.uri.fsPath);
    if (!blame) { editor.setDecorations(blameDecoration, []); return; }

    const cursorLine = editor.selection.active.line; // 0-indexed
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
