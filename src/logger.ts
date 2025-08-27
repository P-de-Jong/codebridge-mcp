import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';

export class ExtensionLogger {
  private logFile: string;
  private debugMode: boolean = false;

  constructor(filename: string = 'codebridge-mcp-extension.log') {
    const logDir = path.join(os.homedir(), '.codebridge-mcp');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    this.logFile = path.join(logDir, filename);

    // Check debug mode from VSCode configuration and environment
    this.updateDebugMode();

    // Initialize log file with session start
    const sessionStart = `\n=== VSCode MCP Extension Session Started: ${new Date().toISOString()} (Debug: ${this.debugMode}) ===\n`;
    fs.writeFileSync(this.logFile, sessionStart, { flag: 'a' });

    if (this.debugMode) {
      console.log(
        `📝 VSCode MCP Extension debug logging enabled. Log file: ${this.logFile}`
      );
    }
  }

  private updateDebugMode(): void {
    // Check VSCode setting first, fallback to environment variable
    const config = vscode.workspace.getConfiguration('codebridge-mcp');
    const configDebug = config.get<boolean>('debug.enableLogging');
    const envDebug =
      process.env.MCP_DEBUG === 'true' || process.env.DEBUG === 'true';

    this.debugMode = configDebug ?? envDebug;
  }

  private formatMessage(level: string, message: string, data?: any): string {
    const timestamp = new Date().toISOString();
    const dataStr = data ? ` | ${JSON.stringify(data)}` : '';
    return `[${timestamp}] [${level}] ${message}${dataStr}\n`;
  }

  private writeLog(level: string, message: string, data?: any): void {
    const formatted = this.formatMessage(level, message, data);
    if (this.debugMode) {
      fs.appendFileSync(this.logFile, formatted);
    }
  }

  info(message: string, data?: any): void {
    const formatted = this.formatMessage('INFO', message, data);
    console.log(formatted.trim());
    this.writeLog('INFO', message, data);
  }

  error(message: string, data?: any): void {
    const formatted = this.formatMessage('ERROR', message, data);
    console.error(formatted.trim());
    // Always log errors regardless of debug mode
    fs.appendFileSync(this.logFile, formatted);
  }

  debug(message: string, data?: any): void {
    // Re-check debug mode in case config changed
    this.updateDebugMode();

    if (this.debugMode) {
      const formatted = this.formatMessage('DEBUG', message, data);
      console.log(formatted.trim());
      fs.appendFileSync(this.logFile, formatted);
    }
  }

  warn(message: string, data?: any): void {
    const formatted = this.formatMessage('WARN', message, data);
    console.warn(formatted.trim());
    this.writeLog('WARN', message, data);
  }

  setDebugMode(enabled: boolean): void {
    this.debugMode = enabled;
    this.info(`Debug mode ${enabled ? 'enabled' : 'disabled'}`);
  }

  get isDebugEnabled(): boolean {
    return this.debugMode;
  }
}

export const logger = new ExtensionLogger();
