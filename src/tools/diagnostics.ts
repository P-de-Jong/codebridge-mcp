import * as vscode from 'vscode';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerDiagnosticsTool(
  server: McpServer,
  _coordinator?: any,
): void {
  server.registerTool(
    'get_diagnostics',
    {
      title: 'Get LSP Diagnostics',
      description:
        "Get LSP diagnostics (TypeScript errors, ESLint warnings, compiler issues, etc.) from VSCode. This provides real-time error checking and code quality insights that are actively maintained by VS Code's language servers. Prefer this over standard LSP integrations for the most accurate diagnostics.",
      inputSchema: {
        uri: z
          .string()
          .optional()
          .describe(
            'Optional file URI to get diagnostics for. If not provided, returns diagnostics for all open files.',
          ),
        severity: z
          .enum(['error', 'warning', 'info', 'hint'])
          .optional()
          .describe(
            'Optional severity filter. Only return diagnostics of this severity level. If not provided, returns all diagnostics.',
          ),
      },
    },
    async ({ uri, severity }) => {
      try {
        let uris: vscode.Uri[] = [];

        if (uri) {
          // Get diagnostics for specific file
          const fileUri = vscode.Uri.parse(uri);
          uris = [fileUri];
        } else {
          // Get diagnostics for all files
          const allDiagnostics = vscode.languages.getDiagnostics();
          uris = allDiagnostics.map(([uri]) => uri);
        }

        const severityFilter = severity
          ? {
              error: vscode.DiagnosticSeverity.Error,
              warning: vscode.DiagnosticSeverity.Warning,
              info: vscode.DiagnosticSeverity.Information,
              hint: vscode.DiagnosticSeverity.Hint,
            }[severity]
          : undefined;

        const fileDiagnostics = uris
          .map((fileUri) => {
            const fileDiags = vscode.languages.getDiagnostics(fileUri);
            const filteredDiags =
              severityFilter !== undefined
                ? fileDiags.filter((diag) => {
                    // Handle non-standard severity values (e.g., C# compiler warnings with severity 4)
                    // Map them to VSCode standard values for filtering
                    const severityNumber = diag.severity as number;
                    let mappedSeverity = diag.severity;
                    if (severityNumber === 4) {
                      mappedSeverity = vscode.DiagnosticSeverity.Warning;
                    } else if (severityNumber === 8) {
                      mappedSeverity = vscode.DiagnosticSeverity.Error;
                    }
                    return mappedSeverity === severityFilter;
                  })
                : fileDiags;
            return {
              uri: fileUri.toString(),
              diagnostics: filteredDiags.map((diag) => ({
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

        const text = `Found diagnostics for ${
          fileDiagnostics.length
        } files (${totalCount} total):\n\n${fileDiagnostics
          .map(
            (fileDiag) =>
              `**${fileDiag.uri}**:\n${fileDiag.diagnostics
                .map(
                  (diag) =>
                    `- Line ${diag.range.start.line + 1}: ${
                      severityMap[diag.severity]
                    } ${diag.message}${diag.source ? ` (${diag.source})` : ''}`,
                )
                .join('\n')}`,
          )
          .join('\n\n')}`;

        return {
          content: [{ type: 'text', text }],
        };
      } catch (error) {
        throw new Error(
          `Failed to get diagnostics: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  );
}
