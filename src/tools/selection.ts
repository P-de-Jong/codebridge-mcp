import * as vscode from 'vscode';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerSelectionTool(
  server: McpServer,
  _coordinator?: any,
): void {
  server.registerTool(
    'get_selection',
    {
      title: 'Get Current Selection',
      description:
        'Get currently selected text from active VSCode editor with surrounding context. Users might refer to "this code" as the selection. Perfect for analyzing specific code sections, understanding highlighted code with its context, and working with user-selected code snippets. Provides 5 lines of context before/after selection.',
      inputSchema: {
        uri: z
          .string()
          .optional()
          .describe('Optional file URI. If not provided, uses active editor.'),
        workspace: z
          .string()
          .optional()
          .describe(
            'Optional workspace name or path to target. Use get_workspaces to see available options.',
          ),
      },
    },
    async ({ uri, workspace: _workspace }) => {
      try {
        let editor: vscode.TextEditor | undefined;

        if (uri) {
          const fileUri = vscode.Uri.parse(uri);
          editor = vscode.window.visibleTextEditors.find(
            (e) => e.document.uri.toString() === fileUri.toString(),
          );
          if (!editor) {
            throw new Error(`No editor found for file: ${uri}`);
          }
        } else {
          editor = vscode.window.activeTextEditor;
          if (!editor) {
            throw new Error('No active editor found');
          }
        }

        const selection = editor.selection;

        // Get workspace context for all cases
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(
          editor.document.uri,
        );
        const workspaceContext = workspaceFolder
          ? `\n\n**Workspace:** ${workspaceFolder.name} (${workspaceFolder.uri.fsPath})`
          : '\n\n**Workspace:** No workspace';

        if (selection.isEmpty) {
          return {
            content: [
              {
                type: 'text',
                text: `No text is currently selected in the editor.${workspaceContext}`,
              },
            ],
          };
        }

        const selectedText = editor.document.getText(selection);
        const document = editor.document;

        // Get surrounding context (5 lines before and after)
        const contextLines = 5;
        const startLine = Math.max(0, selection.start.line - contextLines);
        const endLine = Math.min(
          document.lineCount - 1,
          selection.end.line + contextLines,
        );

        const beforeRange = new vscode.Range(
          startLine,
          0,
          selection.start.line,
          0,
        );
        const afterRange = new vscode.Range(
          selection.end.line + 1,
          0,
          endLine + 1,
          0,
        );

        const beforeText = document.getText(beforeRange).trim();
        const afterText = document.getText(afterRange).trim();

        let contextText = '';
        if (beforeText || afterText) {
          contextText = `\n\n**Context:**`;
          if (beforeText) {
            contextText += `\n\nBefore:\n\`\`\`\n${beforeText}\n\`\`\``;
          }
          if (afterText) {
            contextText += `\n\nAfter:\n\`\`\`\n${afterText}\n\`\`\``;
          }
        }

        // Include file URI and position information for tool integration
        const fileInfo = `\n\n**File:** ${document.uri.toString()}\n**Position:** Line ${selection.start.line + 1}, Character ${selection.start.character + 1}`;

        const text = `Selected text (lines ${selection.start.line + 1}-${selection.end.line + 1}):\n\n\`\`\`\n${selectedText}\n\`\`\`${contextText}${fileInfo}${workspaceContext}`;

        return {
          content: [{ type: 'text', text }],
        };
      } catch (error) {
        throw new Error(
          `Failed to get selection: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
}
