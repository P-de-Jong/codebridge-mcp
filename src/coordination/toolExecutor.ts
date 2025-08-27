import * as vscode from 'vscode';
import * as http from 'http';
import { ExtensionLogger } from '../logger';
import { WorkerInfo } from './types';

export interface ToolResult {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    uri?: string;
    mimeType?: string;
  }>;
}

export interface ToolExecutor {
  executeTool(tool: string, params: any): Promise<ToolResult>;
  getAvailableTools(): string[];
}

/**
 * Local tool executor that uses VSCode APIs directly
 */
export class LocalToolExecutor implements ToolExecutor {
  private logger: ExtensionLogger;

  constructor(logger: ExtensionLogger, _context: vscode.ExtensionContext) {
    this.logger = logger;
  }

  async executeTool(tool: string, params: any): Promise<ToolResult> {
    this.logger.debug('Executing local tool', { tool, params });

    switch (tool) {
      case 'get_open_files':
        return this.executeGetOpenFiles();

      // case 'get_file_content':
      //   return this.executeGetFileContent(params.uri, params.range);

      case 'get_diagnostics':
        return this.executeGetDiagnostics(params.uri);

      case 'get_selection':
        return this.executeGetSelection(params.workspace);

      case 'find_references':
        return this.executeFindReferences(params.uri, params.position);

      case 'find_definition':
        return this.executeFindDefinition(params.uri, params.position);

      case 'get_workspace_symbols':
        return this.executeGetWorkspaceSymbols(params.query);

      case 'get_symbols':
        return this.executeGetSymbols(params.uri);

      case 'get_workspaces':
        return this.executeGetWorkspaces();

      default:
        throw new Error(`Unknown tool: ${tool}`);
    }
  }

  getAvailableTools(): string[] {
    return [
      'get_open_files',
      // 'get_file_content',
      'get_diagnostics',
      'get_selection',
      'find_references',
      'find_definition',
      'get_workspace_symbols',
      'get_symbols',
      'get_workspaces',
    ];
  }

  private async executeGetOpenFiles(): Promise<ToolResult> {
    try {
      const openFiles = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .filter((tab) => tab.input instanceof vscode.TabInputText)
        .map((tab) => {
          const input = tab.input as vscode.TabInputText;
          const document = vscode.workspace.textDocuments.find(
            (doc) => doc.uri.toString() === input.uri.toString(),
          );

          return {
            uri: input.uri.toString(),
            fileName: input.uri.path.split('/').pop() || 'Unknown',
            languageId: document?.languageId || 'unknown',
            isActive: tab.isActive,
            isDirty: tab.isDirty,
          };
        });

      if (openFiles.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No files are currently open in VSCode',
            },
          ],
        };
      }

      const text = `Found ${openFiles.length} open files:\n\n${openFiles
        .map(
          (file) =>
            `**${file.fileName}** (${file.languageId})${file.isActive ? ' 📍 *active*' : ''}${file.isDirty ? ' ✏️ *unsaved*' : ''}\n` +
            `  URI: ${file.uri}`,
        )
        .join('\n\n')}`;

      return {
        content: [{ type: 'text', text }],
      };
    } catch (error) {
      throw new Error(
        `Failed to get open files: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // private async executeGetFileContent(
  //   uri: string,
  //   range?: any,
  // ): Promise<ToolResult> {
  //   try {
  //     const fileUri = vscode.Uri.parse(uri);
  //     const document = await vscode.workspace.openTextDocument(fileUri);

  //     let content: string;
  //     let rangeText = '';

  //     if (range) {
  //       const vsRange = new vscode.Range(
  //         new vscode.Position(range.start.line, range.start.character),
  //         new vscode.Position(range.end.line, range.end.character),
  //       );
  //       content = document.getText(vsRange);
  //       rangeText = ` (lines ${range.start.line + 1}-${range.end.line + 1})`;
  //     } else {
  //       content = document.getText();
  //     }

  //     return {
  //       content: [
  //         {
  //           type: 'text',
  //           text: `File content${rangeText}:\n\n\`\`\`${document.languageId}\n${content}\n\`\`\``,
  //         },
  //       ],
  //     };
  //   } catch (error) {
  //     throw new Error(
  //       `Failed to get file content: ${error instanceof Error ? error.message : String(error)}`,
  //     );
  //   }
  // }

  private async executeGetDiagnostics(uri?: string): Promise<ToolResult> {
    try {
      let uris: vscode.Uri[] = [];

      if (uri) {
        const fileUri = vscode.Uri.parse(uri);
        uris = [fileUri];
      } else {
        const allDiagnostics = vscode.languages.getDiagnostics();
        uris = allDiagnostics.map(([uri]) => uri);
      }

      const fileDiagnostics = uris
        .map((fileUri) => {
          const fileDiags = vscode.languages.getDiagnostics(fileUri);
          return {
            uri: fileUri.toString(),
            diagnostics: fileDiags.map((diag) => ({
              range: {
                start: {
                  line: diag.range.start.line,
                  character: diag.range.start.character,
                },
                end: {
                  line: diag.range.end.line,
                  character: diag.range.end.character,
                },
              },
              severity: diag.severity,
              message: diag.message,
              source: diag.source,
              code: diag.code,
            })),
          };
        })
        .filter((fd) => fd.diagnostics.length > 0);

      const severityMap = {
        [vscode.DiagnosticSeverity.Error]: '❌',
        [vscode.DiagnosticSeverity.Warning]: '⚠️',
        [vscode.DiagnosticSeverity.Information]: 'ℹ️',
        [vscode.DiagnosticSeverity.Hint]: '💡',
      };

      const totalCount = fileDiagnostics.reduce(
        (sum, fd) => sum + fd.diagnostics.length,
        0,
      );

      if (totalCount === 0) {
        return {
          content: [
            {
              type: 'text',
              text: uri
                ? `No diagnostics found for ${uri}`
                : 'No diagnostics found in workspace',
            },
          ],
        };
      }

      const text = `Found diagnostics for ${fileDiagnostics.length} files (${totalCount} total):\n\n${fileDiagnostics
        .map(
          (fileDiag) =>
            `**${fileDiag.uri}**:\n${fileDiag.diagnostics
              .map(
                (diag) =>
                  `- Line ${diag.range.start.line + 1}: ${severityMap[diag.severity]} ${diag.message}${diag.source ? ` (${diag.source})` : ''}`,
              )
              .join('\n')}`,
        )
        .join('\n\n')}`;

      return {
        content: [{ type: 'text', text }],
      };
    } catch (error) {
      throw new Error(
        `Failed to get diagnostics: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async executeGetSelection(
    _workspaceFilter?: string,
  ): Promise<ToolResult> {
    try {
      const activeEditor = vscode.window.activeTextEditor;
      const workspaceInfo = this.getCurrentWorkspaceInfo();

      // Add workspace context to the response
      const workspaceContext = `Workspace: **${workspaceInfo.name}** (${workspaceInfo.path})`;

      if (!activeEditor) {
        return {
          content: [
            {
              type: 'text',
              text: `No active editor found.\n${workspaceContext}`,
            },
          ],
        };
      }

      const selection = activeEditor.selection;
      const selectedText = activeEditor.document.getText(selection);

      if (selection.isEmpty) {
        return {
          content: [
            {
              type: 'text',
              text: `No text selected. Cursor at line ${selection.active.line + 1}, character ${selection.active.character + 1} in file: ${activeEditor.document.fileName}\n\n${workspaceContext}`,
            },
          ],
        };
      }

      const text = `Selected text from ${activeEditor.document.fileName} (lines ${selection.start.line + 1}-${selection.end.line + 1}):\n\n\`\`\`${activeEditor.document.languageId}\n${selectedText}\n\`\`\`\n\n${workspaceContext}`;

      return {
        content: [{ type: 'text', text }],
      };
    } catch (error) {
      throw new Error(
        `Failed to get selection: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async executeFindReferences(
    uri?: string,
    position?: any,
  ): Promise<ToolResult> {
    try {
      let fileUri: vscode.Uri;
      let pos: vscode.Position;

      // If URI is provided, use it, otherwise fall back to active editor
      if (uri && position) {
        fileUri = vscode.Uri.parse(uri);
        pos = new vscode.Position(position.line, position.character);
      } else {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
          return {
            content: [
              {
                type: 'text',
                text: 'No URI provided and no active editor available.',
              },
            ],
          };
        }
        fileUri = activeEditor.document.uri;
        // Use provided position if available, otherwise use current selection
        if (position) {
          pos = new vscode.Position(position.line, position.character);
        } else {
          pos = activeEditor.selection.active;
        }
      }

      const references = await vscode.commands.executeCommand<
        vscode.Location[]
      >('vscode.executeReferenceProvider', fileUri, pos);

      if (!references || references.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No references found at position line ${pos.line + 1}, character ${pos.character + 1} in ${fileUri.toString()}`,
            },
          ],
        };
      }

      const text = `Found ${references.length} references:\n\n${references
        .map(
          (ref) =>
            `**${ref.uri.toString()}** (line ${ref.range.start.line + 1}:${ref.range.start.character + 1})`,
        )
        .join('\n')}`;

      return {
        content: [{ type: 'text', text }],
      };
    } catch (error) {
      throw new Error(
        `Failed to find references: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async executeFindDefinition(
    uri: string,
    position: any,
  ): Promise<ToolResult> {
    try {
      const fileUri = vscode.Uri.parse(uri);
      const pos = new vscode.Position(position.line, position.character);

      const definitions = await vscode.commands.executeCommand<
        vscode.Location[]
      >('vscode.executeDefinitionProvider', fileUri, pos);

      if (!definitions || definitions.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No definition found at position line ${position.line + 1}, character ${position.character + 1} in ${uri}`,
            },
          ],
        };
      }

      const text = `Found ${definitions.length} definition(s):\n\n${definitions
        .map(
          (def) =>
            `**${def.uri.toString()}** (line ${def.range.start.line + 1}:${def.range.start.character + 1})`,
        )
        .join('\n')}`;

      return {
        content: [{ type: 'text', text }],
      };
    } catch (error) {
      throw new Error(
        `Failed to find definition: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async executeGetWorkspaceSymbols(query: string): Promise<ToolResult> {
    try {
      const symbols = await vscode.commands.executeCommand<
        vscode.SymbolInformation[]
      >('vscode.executeWorkspaceSymbolProvider', query);

      if (!symbols || symbols.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No symbols found matching query: "${query}"`,
            },
          ],
        };
      }

      const symbolKindMap: { [key: number]: string } = {
        [vscode.SymbolKind.File]: 'File',
        [vscode.SymbolKind.Module]: 'Module',
        [vscode.SymbolKind.Class]: 'Class',
        [vscode.SymbolKind.Method]: 'Method',
        [vscode.SymbolKind.Function]: 'Function',
        [vscode.SymbolKind.Variable]: 'Variable',
        [vscode.SymbolKind.Interface]: 'Interface',
        [vscode.SymbolKind.Property]: 'Property',
      };

      const text = `Found ${symbols.length} symbols matching "${query}":\n\n${symbols
        .slice(0, 50) // Limit results
        .map(
          (symbol) =>
            `**${symbol.name}** (${symbolKindMap[symbol.kind] || 'Unknown'}) in ${symbol.location.uri.toString()}:${symbol.location.range.start.line + 1}`,
        )
        .join('\n')}`;

      return {
        content: [{ type: 'text', text }],
      };
    } catch (error) {
      throw new Error(
        `Failed to get workspace symbols: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async executeGetSymbols(uri: string): Promise<ToolResult> {
    try {
      const fileUri = vscode.Uri.parse(uri);
      const symbols = await vscode.commands.executeCommand<
        vscode.DocumentSymbol[]
      >('vscode.executeDocumentSymbolProvider', fileUri);

      if (!symbols || symbols.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No symbols found in ${uri}`,
            },
          ],
        };
      }

      const formatSymbol = (
        symbol: vscode.DocumentSymbol,
        indent: string = '',
      ): string => {
        const range = `${symbol.range.start.line + 1}:${symbol.range.start.character + 1}`;
        let result = `${indent}**${symbol.name}** (${vscode.SymbolKind[symbol.kind]}) at line ${range}`;

        if (symbol.children && symbol.children.length > 0) {
          result +=
            '\n' +
            symbol.children
              .map((child) => formatSymbol(child, indent + '  '))
              .join('\n');
        }

        return result;
      };

      const text = `Symbols in ${uri}:\n\n${symbols
        .map((symbol) => formatSymbol(symbol))
        .join('\n\n')}`;

      return {
        content: [{ type: 'text', text }],
      };
    } catch (error) {
      throw new Error(
        `Failed to get symbols: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async executeGetWorkspaces(): Promise<ToolResult> {
    try {
      const workspaceData = this.getCurrentWorkspaceInfo();

      return {
        content: [
          {
            type: 'text',
            text: `Current workspace: **${workspaceData.name}** at ${workspaceData.path}`,
          },
        ],
      };
    } catch (error) {
      throw new Error(
        `Failed to get workspace info: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private getCurrentWorkspaceInfo() {
    // Determine workspace name and path - prefer workspace file over first folder
    const workspaceFile = vscode.workspace.workspaceFile;
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const firstFolder = workspaceFolders?.[0];

    if (workspaceFile && workspaceFolders) {
      // Multi-folder workspace with .code-workspace file
      const workspaceName =
        workspaceFile.path.split('/').pop()?.replace('.code-workspace', '') ||
        'Unknown Workspace';

      // Include all folders in the workspace
      const folders = workspaceFolders.map((folder) => ({
        name: folder.name,
        path: folder.uri.fsPath,
      }));

      return {
        name: workspaceName,
        path: workspaceFile.path,
        type: 'multi-folder' as const,
        folders: folders,
      };
    } else if (firstFolder) {
      // Single folder workspace
      return {
        name: firstFolder.name,
        path: firstFolder.uri.fsPath,
        type: 'single-folder' as const,
        folders: [
          {
            name: firstFolder.name,
            path: firstFolder.uri.fsPath,
          },
        ],
      };
    } else {
      // No workspace open
      return {
        name: 'No Workspace',
        path: process.cwd(),
        type: 'none' as const,
        folders: [],
      };
    }
  }
}

/**
 * Remote tool executor that calls tools on worker instances via HTTP
 */
export class RemoteToolExecutor implements ToolExecutor {
  private logger: ExtensionLogger;
  private workerInfo: WorkerInfo;
  private timeout: number = 30000; // 30 second timeout
  private maxRetries: number = 3;
  private retryDelay: number = 1000; // 1 second base delay

  constructor(logger: ExtensionLogger, workerInfo: WorkerInfo) {
    this.logger = logger;
    this.workerInfo = workerInfo;
  }

  async executeTool(tool: string, params: any): Promise<ToolResult> {
    this.logger.debug('Executing remote tool', {
      tool,
      worker: this.workerInfo.instanceId,
      workerPort: this.workerInfo.port,
    });

    return await this.executeWithRetry(tool, params, 0);
  }

  private async executeWithRetry(
    tool: string,
    params: any,
    attempt: number,
  ): Promise<ToolResult> {
    try {
      return await this.makeHttpRequest(tool, params);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      if (attempt < this.maxRetries) {
        const delay = this.retryDelay * Math.pow(2, attempt); // Exponential backoff
        this.logger.warn('Tool execution failed, retrying', {
          tool,
          worker: this.workerInfo.instanceId,
          attempt: attempt + 1,
          maxRetries: this.maxRetries,
          delay,
          error: errorMessage,
        });

        await this.sleep(delay);
        return await this.executeWithRetry(tool, params, attempt + 1);
      } else {
        this.logger.error('Tool execution failed after all retries', {
          tool,
          worker: this.workerInfo.instanceId,
          attempts: this.maxRetries + 1,
          error: errorMessage,
        });
        throw error;
      }
    }
  }

  private makeHttpRequest(tool: string, params: any): Promise<ToolResult> {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(params);
      const options = {
        hostname: 'localhost',
        port: this.workerInfo.port,
        path: `/tools/${tool}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      };

      const req = http.request(options, (res) => {
        let responseData = '';

        res.on('data', (chunk) => {
          responseData += chunk;
        });

        res.on('end', () => {
          try {
            const response = JSON.parse(responseData);
            if (response.success) {
              resolve(response.result);
            } else {
              reject(new Error(response.error || 'Tool execution failed'));
            }
          } catch (error) {
            reject(
              new Error(`Invalid JSON response from worker: ${responseData}`),
            );
          }
        });
      });

      req.on('error', (error) => {
        reject(new Error(`Worker communication failed: ${error.message}`));
      });

      req.setTimeout(this.timeout, () => {
        req.destroy();
        reject(new Error(`Tool execution timeout after ${this.timeout}ms`));
      });

      req.write(postData);
      req.end();
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  getAvailableTools(): string[] {
    return this.workerInfo.capabilities;
  }

  getWorkerInfo(): WorkerInfo {
    return this.workerInfo;
  }
}
