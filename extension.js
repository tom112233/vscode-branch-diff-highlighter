const vscode = require('vscode');
const { exec } = require('child_process');
const path = require('path');

let addedDecoration;
let modifiedDecoration;
let blameDecoration;
let statusBarItem;
let historyOutputChannel;
let codeLensProvider;

const pendingUpdates = new Map();
const fileData = new Map();
const blameCache = new Map();
const baseContentMap = new Map();

class HunkCodeLensProvider {
    constructor() {
        this._emitter = new vscode.EventEmitter();
        this.onDidChangeCodeLenses = this._emitter.event;
    }
    refresh() { this._emitter.fire(); }
    provideCodeLenses(document) {
        const data = fileData.get(document.uri.fsPath);
        if (!data || !data.hunks.length) return [];
        const wf = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!wf) return [];
        const cwd = wf.uri.fsPath;
        const relPath = path.relative(cwd, document.uri.fsPath);
        const baseBranch = vscode.workspace.getConfiguration('branchDiffHighlighter').get('baseBranch', 'master');
        const lenses = [];
        for (const hunk of data.hunks) {
            const range = new vscode.Range(hunk.startLine - 1, 0, hunk.startLine - 1, 0);
            const args = [{ cwd, relPath, rawHunk: hunk.rawHunk, startLine: hunk.startLine, endLine: hunk.endLine, baseBranch }];
            lenses.push(new vscode.CodeLens(range, { title: '$(diff) View diff', command: 'branchDiffHighlighter.openDiff', arguments: args }));
            lenses.push(new vscode.CodeLens(range, { title: '$(discard) Revert', command: 'branchDiffHighlighter.revertHunk', arguments: args }));
            lenses.push(new vscode.CodeLens(range, { title: '$(history) History', command: 'branchDiffHighlighter.showBlockHistory', arguments: args }));
        }
        return lenses;
    }
}

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

    codeLensProvider = new HunkCodeLensProvider();
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLensProvider)
    );

    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('branch-diff', {
            provideTextDocumentContent(uri) { return baseContentMap.get(uri.toString()) || ''; }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('branchDiffHighlighter.openDiff', (args) => {
            const { cwd, relPath, startLine, endLine, baseBranch } = args;
            const filename = path.basename(relPath);
            exec(`git show "${baseBranch}:${relPath}"`, { cwd, maxBuffer: 1024 * 1024 * 10 }, (err, stdout) => {
                const baseUri = vscode.Uri.parse(`branch-diff:///${relPath.replace(/\\/g, '/')}`);
                baseContentMap.set(baseUri.toString(), stdout || '');
                const fileUri = vscode.Uri.file(path.join(cwd, relPath));
                const selection = new vscode.Range(Math.max(0, startLine - 1), 0, Math.max(0, endLine - 1), 0);
                vscode.commands.executeCommand('vscode.diff', baseUri, fileUri, `${baseBranch} ↔ HEAD — ${filename}`, { selection });
            });
        })
    );
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
            vscode.window.showInformationMessage(`Diff layout: ${!current ? 'side-by-side' : 'inline'}`);
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
    }, null, context.subscriptions);

    if (vscode.window.activeTextEditor) {
        scheduleUpdate(vscode.window.activeTextEditor);
        updateBlame(vscode.window.activeTextEditor);
    }
}

async function revertHunk(args) {
    if (!args) return;
    const { cwd, relPath, rawHunk } = args;
    const confirmed = await vscode.window.showWarningMessage(
        `Revert this block in ${path.basename(relPath)}?`, { modal: true }, 'Revert'
    );
    if (confirmed !== 'Revert') return;
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

    exec(`git diff "${baseBranch}...HEAD" -- "${relPath}"`, { cwd, maxBuffer: 1024 * 1024 * 10 }, (err, stdout) => {
        if (err || !stdout) {
            fileData.delete(filePath);
            editor.setDecorations(addedDecoration, []);
            editor.setDecorations(modifiedDecoration, []);
            statusBarItem.hide();
            codeLensProvider.refresh();
            return;
        }
        const parsed = parseDiff(stdout);
        fileData.set(filePath, parsed);
        const tip = new vscode.MarkdownString('$(arrow-right) Click **View diff** above to open diff');
        tip.isTrusted = true;
        editor.setDecorations(addedDecoration, parsed.added.map(n => ({ range: new vscode.Range(n - 1, 0, n - 1, 0), hoverMessage: tip })));
        editor.setDecorations(modifiedDecoration, parsed.modified.map(n => ({ range: new vscode.Range(n - 1, 0, n - 1, 0), hoverMessage: tip })));
        statusBarItem.text = `$(diff) +${parsed.addedCount} -${parsed.deletedCount}`;
        statusBarItem.show();
        codeLensProvider.refresh();
    });
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
            if (l.startsWith('-')) { deletionInBlock = true; deletedCount++; }
            else if (l.startsWith('+')) {
                lineNum++; addedCount++;
                if (deletionInBlock) { modified.push(lineNum); } else { added.push(lineNum); }
                hunkEndLine = lineNum;
            } else { deletionInBlock = false; if (!l.startsWith('\\')) lineNum++; }
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
    exec(`git blame --line-porcelain -- "${relPath}"`, { cwd, maxBuffer: 1024 * 1024 * 20 }, (err, stdout) => {
        if (err || !stdout) return;
        blameCache.set(filePath, parseBlame(stdout));
        updateBlameDecoration(editor);
    });
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
        renderOptions: { after: { contentText: `  ${entry.author} · ${entry.relTime}`, color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic' } }
    }]);
}

function deactivate() {}
module.exports = { activate, deactivate };
