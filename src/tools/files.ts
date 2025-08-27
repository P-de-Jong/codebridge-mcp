import * as vscode from 'vscode';
// import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerFileTools(server: McpServer, _coordinator?: any): void {
  // Get open files tool
  server.registerTool(
    'get_open_files',
    {
      title: 'Get Open Files',
      description:
        'Get list of currently open files/tabs in VSCode editor. Useful for understanding the current workspace context, finding active files, and identifying unsaved changes. Shows file names, language types, and edit status.',
      inputSchema: {},
    },
    async () => {
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
    },
  );

  // // Get file content tool
  // server.registerTool(
  //   'get_file_content',
  //   {
  //     title: 'Get File Content',
  //     description:
  //       'Get content of a specific file from VSCode editor. This reads the current in-memory version of the file (including unsaved changes), not the disk version. Supports reading partial content by line range. Can optionally target a specific workspace. Essential for analyzing code that may have been modified but not saved.',
  //     inputSchema: {
  //       uri: z.string().describe('File URI to get content for'),
  //       workspace: z
  //         .string()
  //         .optional()
  //         .describe(
  //           'Optional workspace name or path to target. Use get_workspaces to see available options.',
  //         ),
  //       range: z
  //         .object({
  //           start: z.object({
  //             line: z.number(),
  //             character: z.number(),
  //           }),
  //           end: z.object({
  //             line: z.number(),
  //             character: z.number(),
  //           }),
  //         })
  //         .optional()
  //         .describe('Optional range to get partial content'),
  //     },
  //   },
  //   async ({ uri, workspace: _workspace, range }) => {
  //     try {
  //       const fileUri = vscode.Uri.parse(uri);
  //       const document = await vscode.workspace.openTextDocument(fileUri);

  //       let content: string;
  //       let rangeText = '';

  //       if (range) {
  //         const vsRange = new vscode.Range(
  //           new vscode.Position(range.start.line, range.start.character),
  //           new vscode.Position(range.end.line, range.end.character),
  //         );
  //         content = document.getText(vsRange);
  //         rangeText = ` (lines ${range.start.line + 1}-${range.end.line + 1})`;
  //       } else {
  //         content = document.getText();
  //       }

  //       return {
  //         content: [
  //           {
  //             type: 'text',
  //             text: `File content${rangeText}:\n\n\`\`\`${document.languageId}\n${content}\n\`\`\``,
  //           },
  //         ],
  //       };
  //     } catch (error) {
  //       throw new Error(
  //         `Failed to get file content: ${error instanceof Error ? error.message : String(error)}`,
  //       );
  //     }
  //   },
  // );
}
