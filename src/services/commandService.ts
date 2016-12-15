import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import kill = require('tree-kill');
import PathService from './pathService';

import elegantSpinner = require('elegant-spinner');
const spinner = elegantSpinner();

const errorRegex = /^(.*):(\d+):(\d+):\s+(\d+):(\d+)\s+(warning|error|note|help):\s+(.*)$/;

interface RustError {
    filename: string;
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
    severity: string;
    message: string;
}

export enum ErrorFormat {
    OldStyle,
    NewStyle,
    JSON
}

class ChannelWrapper {
    private owner: CargoTask;
    private channel: vscode.OutputChannel;

    constructor(channel: vscode.OutputChannel) {
        this.channel = channel;
    }

    public append(task: CargoTask, message: string): void {
        if (task === this.owner) {
            this.channel.append(message);
        }
    }

    public clear(task: CargoTask): void {
        if (task === this.owner) {
            this.channel.clear();
        }
    }

    public show(): void {
        this.channel.show(true);
    }

    public setOwner(owner: CargoTask): void {
        this.owner = owner;
    }
}

class CargoTask {
    private channel: ChannelWrapper;
    private process: cp.ChildProcess;
    private arguments: string[];
    private interrupted: boolean;

    constructor(args: string[], channel: ChannelWrapper) {
        this.arguments = args;
        this.channel = channel;
        this.interrupted = false;
    }

    public execute(cwd: string): Thenable<string> {
        return new Promise((resolve, reject) => {
            const cargoPath = PathService.getCargoPath();
            const startTime = Date.now();
            const task = 'cargo ' + this.arguments.join(' ');
            const errorFormat = CommandService.errorFormat;

            let output = '';

            this.channel.clear(this);
            this.channel.append(this, `Running "${task}":\n`);

            let newEnv = Object.assign({}, process.env);

            let customEnv = vscode.workspace.getConfiguration('rust')['cargoEnv'];
            if (customEnv) {
                newEnv = Object.assign(newEnv, customEnv);
            }

            if (errorFormat === ErrorFormat.JSON) {
                newEnv['RUSTFLAGS'] = '-Zunstable-options --error-format=json';
            } else if (errorFormat === ErrorFormat.NewStyle) {
                newEnv['RUST_NEW_ERROR_FORMAT'] = 'true';
            }

            this.process = cp.spawn(cargoPath, this.arguments, { cwd, env: newEnv });

            this.process.stdout.on('data', data => {
                this.channel.append(this, data.toString());
            });
            this.process.stderr.on('data', data => {
                output += data.toString();

                // If the user has selected JSON errors, we defer the output to process exit
                // to allow us to parse the errors into something human readable.
                // Otherwise we just emit the output as-is.
                if (errorFormat !== ErrorFormat.JSON) {
                    this.channel.append(this, data.toString());
                }
            });
            this.process.on('error', error => {
                if (error.code === 'ENOENT') {
                    vscode.window.showInformationMessage('The "cargo" command is not available. Make sure it is installed.');
                }
            });
            this.process.on('exit', code => {
                this.process.removeAllListeners();
                this.process = null;

                // If the user has selected JSON errors, we need to parse and print them into something human readable
                // It might not match Rust 1-to-1, but its better than JSON
                if (errorFormat === ErrorFormat.JSON) {
                    for (const line of output.split('\n')) {
                        // Catch any JSON lines
                        if (line.startsWith('{')) {
                            let errors: RustError[] = [];
                            if (CommandService.parseJsonLine(errors, line)) {
                                /* tslint:disable:max-line-length */
                                // Print any errors as best we can match to Rust's format.
                                // TODO: Add support for child errors/text highlights.
                                // TODO: The following line will currently be printed fine, but the two lines after will not.
                                // src\main.rs:5:5: 5:8 error: expected one of `!`, `.`, `::`, `;`, `?`, `{`, `}`, or an operator, found `let`
                                // src\main.rs:5     let mut a = 4;
                                //                   ^~~
                                /* tslint:enable:max-line-length */
                                for (const error of errors) {
                                    this.channel.append(this, `${error.filename}:${error.startLine}:${error.startCharacter}:` +
                                        ` ${error.endLine}:${error.endCharacter} ${error.severity}: ${error.message}\n`);
                                }
                            }
                        } else {
                            // Catch any non-JSON lines like "Compiling <project> (<path>)"
                            this.channel.append(this, `${line}\n`);
                        }
                    }
                }

                const endTime = Date.now();
                this.channel.append(this, `\n"${task}" completed with code ${code}`);
                this.channel.append(this, `\nIt took approximately ${(endTime - startTime) / 1000} seconds`);

                if (code === 0 || this.interrupted) {
                    resolve(this.interrupted ? '' : output);
                } else {
                    if (code !== 101) {
                        vscode.window.showWarningMessage(`Cargo unexpectedly stopped with code ${code}`);
                    }
                    reject(output);
                }
            });
        });
    }

    public kill(): Thenable<any> {
        return new Promise(resolve => {
            if (!this.interrupted && this.process) {
                kill(this.process.pid, 'SIGINT', resolve);
                this.interrupted = true;
            }
        });
    }
}

export class CommandService {
    private static diagnostics: vscode.DiagnosticCollection = vscode.languages.createDiagnosticCollection('rust');
    private static channel: ChannelWrapper = new ChannelWrapper(vscode.window.createOutputChannel('Cargo'));
    private static currentTask: CargoTask;
    private static statusBarItem: vscode.StatusBarItem;
    private static spinnerUpdate: any;
    public static errorFormat: ErrorFormat;

    public static formatCommand(commandName: string, ...args: string[]): vscode.Disposable {
        return vscode.commands.registerCommand(commandName, () => {
            this.runCargo(args, true);
        });
    }

    public static buildExampleCommand(commandName: string, release: boolean): vscode.Disposable {
        return vscode.commands.registerCommand(commandName, () => {
            this.buildExample(release);
        });
    }

    public static runExampleCommand(commandName: string, release: boolean): vscode.Disposable {
        return vscode.commands.registerCommand(commandName, () => {
            this.runExample(release);
        });
    }

    public static stopCommand(commandName: string): vscode.Disposable {
        return vscode.commands.registerCommand(commandName, () => {
            if (this.currentTask) {
                this.currentTask.kill();
            }
        });
    }

    public static updateErrorFormat(): void {
        const config = vscode.workspace.getConfiguration('rust');
        if (config['useJsonErrors'] === true) {
            this.errorFormat = ErrorFormat.JSON;
        } else if (config['useNewErrorFormat'] === true) {
            this.errorFormat = ErrorFormat.NewStyle;
        } else {
            this.errorFormat = ErrorFormat.OldStyle;
        }
    }

    private static determineExampleName(): string {
        let showDocumentIsNotExampleWarning = () => {
            vscode.window.showWarningMessage('Current document is not an example');
        };
        let filePath = vscode.window.activeTextEditor.document.uri.fsPath;
        let dir = path.basename(path.dirname(filePath));
        if (dir !== 'examples') {
            showDocumentIsNotExampleWarning();
            return '';
        }
        let filename = path.basename(filePath);
        if (!filename.endsWith('.rs')) {
            showDocumentIsNotExampleWarning();
            return '';
        }
        return path.basename(filename, '.rs');
    }

    private static buildExample(release: boolean): void {
        let exampleName = this.determineExampleName();
        if (exampleName.length === 0) {
            return;
        }
        let args = ['build', '--example', exampleName];
        if (release) {
            args.push('--release');
        }
        this.runCargo(args, true);
    }

    private static runExample(release: boolean): void {
        let exampleName = this.determineExampleName();
        if (exampleName.length === 0) {
            return;
        }
        let args = ['run', '--example', exampleName];
        if (release) {
            args.push('--release');
        }
        this.runCargo(args, true);
    }

    private static parseDiagnostics(cwd: string, output: string): void {
        let errors: RustError[] = [];
        // The new Rust error format is a little more complex and is spread out over
        // multiple lines. For this case, we'll just use a global regex to get our matches
        if (this.errorFormat === ErrorFormat.NewStyle) {
            try {
                this.parseNewHumanReadable(errors, output);
            } catch (e) {
                // catch errors here instead of propagating them upwards, which
                // kills error parsing until reload
                console.error('parseNewHumanReadable returned error: ' + e);
                errors.push({
                    filename: 'NONE',
                    startLine: 1,
                    startCharacter: 1,
                    endLine: 1,
                    endCharacter: 1,
                    severity: 'error',
                    message: 'RustyCode failed to parse error output'
                });
            }
        } else {
            // Otherwise, parse out the errors line by line.
            for (let line of output.split('\n')) {
                if (this.errorFormat === ErrorFormat.JSON && line.startsWith('{')) {
                    this.parseJsonLine(errors, line);
                } else {
                    this.parseOldHumanReadable(errors, line);
                }
            }
        }

        let mapSeverityToVsCode = (severity) => {
            if (severity === 'warning') {
                return vscode.DiagnosticSeverity.Warning;
            } else if (severity === 'error') {
                return vscode.DiagnosticSeverity.Error;
            } else if (severity === 'note') {
                return vscode.DiagnosticSeverity.Information;
            } else if (severity === 'help') {
                return vscode.DiagnosticSeverity.Hint;
            } else {
                return vscode.DiagnosticSeverity.Error;
            }
        };

        this.diagnostics.clear();

        let diagnosticMap: Map<string, vscode.Diagnostic[]> = new Map();
        errors.forEach(error => {
            let filePath = path.join(cwd, error.filename);
            // handle Windows full paths; path.join horks on these (???)
            if (error.filename.length > 3 && error.filename[1] === ':' && error.filename[2] === '\\') {
                filePath = error.filename;
            }
            // VSCode starts its lines and columns at 0, so subtract 1 off 
            let range = new vscode.Range(error.startLine - 1, error.startCharacter - 1, error.endLine - 1, error.endCharacter - 1);
            let severity = mapSeverityToVsCode(error.severity);

            let diagnostic = new vscode.Diagnostic(range, error.message, severity);
            let diagnostics = diagnosticMap.get(filePath);
            if (!diagnostics) {
                diagnostics = [];
            }
            diagnostics.push(diagnostic);

            diagnosticMap.set(filePath, diagnostics);
        });

        diagnosticMap.forEach((diags, uri) => {
            this.diagnostics.set(vscode.Uri.file(uri), diags);
        });

        // we want to open the errors/warnings panel, but without focusing it
        vscode.commands.executeCommand('workbench.action.showErrorsWarnings');
        // this is a workaround to showErrorsWarnings stealing focus.  This puts
        // it back to where it should be.
        vscode.commands.executeCommand('search.action.focusActiveEditor');
    }

    private static parseOldHumanReadable(errors: RustError[], line: string): void {
        let match = line.match(errorRegex);
        if (match) {
            let filename = match[1];
            if (!errors[filename]) {
                errors[filename] = [];
            }

            errors.push({
                filename: filename,
                startLine: Number(match[2]),
                startCharacter: Number(match[3]),
                endLine: Number(match[4]),
                endCharacter: Number(match[5]),
                severity: match[6],
                message: match[7]
            });
        }
    }

    private static parseNewHumanReadable(errors: RustError[], output: string): void {
        let newErrorRegex = new RegExp('(warning|error|note|help)(?:\\[(.*)\\])?\\: (.*)\\s+--> '
            + '(.*):(\\d+):(\\d+)\\n(?:((?:.+\\n)+)\\.+)?(?:[\\d\\s]+\\|.*)*\\n((?:\\s+=.*)+)?', 'g');
        let newErrorRange = /\s+\|[ _-]+(\^+)/g;

        while (true) {
            const match = newErrorRegex.exec(output);
            const range = newErrorRange.exec(output);
            if (match == null) {
                break;
            }

            let filename = match[4];
            if (!errors[filename]) {
                errors[filename] = [];
            }

            let startLine = Number(match[5]);
            let startCharacter = Number(match[6]);

            let msg = match[3];
            if (match[7]) {
                msg += '\n';
                let thisMsg = match[7];
                while (/\d+ \|\s{2}/g.test(thisMsg)) {
                    thisMsg = thisMsg.replace(/\|\s{2}/g, '| ');
                }
                msg += thisMsg.substring(0, thisMsg.length - 1);
            }

            if (match[8]) {
                msg += '\n' + match[8];
            }

            // TODO: some errors report multi-line start/end, e.g.:
            //
            // warning: method is never used: `next_scroll_layer_id`, #[warn(dead_code)] on by default
            //    --> src\wrench.rs:220:5
            //     |
            // 220 |       pub fn next_scroll_layer_id(&mut self) -> ScrollLayerId {
            //     |  _____^ starting here...
            // 221 | |         let scroll_layer_id = ServoScrollRootId(self.next_scroll_layer_id);
            // 222 | |         self.next_scroll_layer_id += 1;
            // 223 | |         ScrollLayerId::new(self.root_pipeline_id, 0, scroll_layer_id)
            // 224 | |     }
            //     | |_____^ ...ending here
            //
            // We need to handle the "ending here" bit and pull out the proper line number.
            //
            // But -- hopefully JSON errors will stabilize quickly and we can avoid this entire mess.

            let endLine = startLine;
            let endCharacter = startCharacter + range[1].length;

            errors.push({
                filename: filename,
                startLine: startLine,
                startCharacter: startCharacter,
                endLine: endLine,
                endCharacter: endCharacter,
                severity: match[1],
                message: msg
            });
        }
    };

    public static parseJsonLine(errors: RustError[], line: string): boolean {
        let errorJson = JSON.parse(line);
        return this.parseJson(errors, errorJson);
    }

    private static parseJson(errors: RustError[], errorJson: any): boolean {
        let spans = errorJson.spans;
        if (spans.length === 0) {
            return false;
        }

        for (let span of errorJson.spans) {
            // Only add the primary span, as VSCode orders the problem window by the 
            // error's range, which causes a lot of confusion if there are duplicate messages.
            if (span.is_primary) {
                let error: RustError = {
                    filename: span.file_name,
                    startLine: span.line_start,
                    startCharacter: span.column_start,
                    endLine: span.line_end,
                    endCharacter: span.column_end,
                    severity: errorJson.level,
                    message: errorJson.message
                };

                errors.push(error);
            }
        }

        return true;
    }

    private static showSpinner(): void {
        if (this.statusBarItem == null) {
            this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
            this.statusBarItem.text = spinner();
            this.statusBarItem.tooltip = 'Running Cargo Task';
        }

        this.statusBarItem.show();

        if (this.spinnerUpdate == null) {
            this.spinnerUpdate = setInterval(() => {
                this.statusBarItem.text = spinner();
            }, 50);
        }
    }

    private static hideSpinner(): void {
        if (this.spinnerUpdate != null) {
            clearInterval(this.spinnerUpdate);
            this.spinnerUpdate = null;
        }

        if (this.statusBarItem != null) {
            this.statusBarItem.hide();
        }
    }

    private static runCargo(args: string[], force = false): void {
        if (force && this.currentTask) {
            this.channel.setOwner(null);
            this.currentTask.kill().then(() => {
                this.runCargo(args, force);
            });
            return;
        } else if (this.currentTask) {
            return;
        }

        const rustConfig = vscode.workspace.getConfiguration('rust');

        // collect feature flags
        let features: any = [];
        if (rustConfig['features'].length > 0) {
            features.push('--features');
            features.push(rustConfig['features'].join(' '));
        }

        // replace args with new instance containing feature flags, features
        // must be placed before doubledash `--`
        let doubledash = args.indexOf('--');
        let argsWithFatures: string[];
        if (doubledash >= 0) {
            argsWithFatures = args.concat();
            argsWithFatures.splice.apply(argsWithFatures, [doubledash, 0].concat(features));
        } else {
            argsWithFatures = args.concat(features);
        }

        this.currentTask = new CargoTask(argsWithFatures, this.channel);

        this.channel.setOwner(this.currentTask);

        if (rustConfig['showOutput']) {
            this.channel.show();
        }

        PathService.cwd().then((value: string | Error) => {
            if (typeof value === 'string') {
                this.showSpinner();
                this.currentTask.execute(value).then(output => {
                    this.hideSpinner();
                    this.parseDiagnostics(value, output);
                }, output => {
                    this.hideSpinner();
                    this.parseDiagnostics(value, output);
                }).then(() => {
                    this.currentTask = null;
                });
            } else {
                vscode.window.showErrorMessage(value.message);
            }
        });
    }
}
