const vscode = require('vscode');
const { exec } = require('child_process');
const path = require('path');

let addedDecoration;
let modifiedDecoration;
const pendingUpdates = new Map();

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

    vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) scheduleUpdate(editor);
    }, null, context.subscriptions);

    vscode.workspace.onDidSaveTextDocument(doc => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document === doc) scheduleUpdate(editor);
    }, null, context.subscriptions);

    if (vscode.window.activeTextEditor) {
        scheduleUpdate(vscode.window.activeTextEditor);
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
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!workspaceFolder) return;

    const cwd = workspaceFolder.uri.fsPath;
    const baseBranch = vscode.workspace.getConfiguration('branchDiffHighlighter').get('baseBranch', 'master');
    const relPath = path.relative(cwd, filePath);

    exec(
        `git diff "${baseBranch}...HEAD" -- "${relPath}"`,
        { cwd, maxBuffer: 1024 * 1024 * 10 },
        (err, stdout) => {
            if (err || !stdout) {
                editor.setDecorations(addedDecoration, []);
                editor.setDecorations(modifiedDecoration, []);
                return;
            }
            const { added, modified } = parseDiff(stdout);
            editor.setDecorations(addedDecoration, added.map(n => new vscode.Range(n - 1, 0, n - 1, 0)));
            editor.setDecorations(modifiedDecoration, modified.map(n => new vscode.Range(n - 1, 0, n - 1, 0)));
        }
    );
}

function parseDiff(diffOutput) {
    const added = [];
    const modified = [];
    const lines = diffOutput.split('\n');
    let i = 0;

    while (i < lines.length) {
        if (!lines[i].startsWith('@@')) { i++; continue; }

        const m = lines[i].match(/\+(\d+)/);
        if (!m) { i++; continue; }

        let lineNum = parseInt(m[1]) - 1;
        i++;

        const hunk = [];
        while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff ')) {
            hunk.push(lines[i]);
            i++;
        }

        // classify each + line: modified if preceded by - in the same block, else added
        let deletionInBlock = false;
        for (const l of hunk) {
            if (l.startsWith('-')) {
                deletionInBlock = true;
            } else if (l.startsWith('+')) {
                lineNum++;
                if (deletionInBlock) {
                    modified.push(lineNum);
                } else {
                    added.push(lineNum);
                }
            } else {
                deletionInBlock = false;
                if (!l.startsWith('\\')) lineNum++;
            }
        }
    }

    return { added, modified };
}

function deactivate() {}

module.exports = { activate, deactivate };
