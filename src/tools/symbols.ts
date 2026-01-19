import * as vscode from 'vscode';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerSymbolsTool(
  server: McpServer,
  _coordinator?: any,
): void {
  server.registerTool(
    'get_workspace_symbols',
    {
      title: 'Search Workspace Symbols',
      description:
        'Search for symbols (functions, classes, variables, methods, etc.) across the entire workspace. Excellent for code exploration, finding specific implementations, discovering APIs, and navigating large codebases. Must be used before answering symbol discovery or location questions. Returns symbol types, locations, and container information.',
      inputSchema: {
        query: z.string().describe('Search query for symbols'),
      },
    },
    async ({ query }) => {
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
          [vscode.SymbolKind.Namespace]: 'Namespace',
          [vscode.SymbolKind.Package]: 'Package',
          [vscode.SymbolKind.Class]: 'Class',
          [vscode.SymbolKind.Method]: 'Method',
          [vscode.SymbolKind.Property]: 'Property',
          [vscode.SymbolKind.Field]: 'Field',
          [vscode.SymbolKind.Constructor]: 'Constructor',
          [vscode.SymbolKind.Enum]: 'Enum',
          [vscode.SymbolKind.Interface]: 'Interface',
          [vscode.SymbolKind.Function]: 'Function',
          [vscode.SymbolKind.Variable]: 'Variable',
          [vscode.SymbolKind.Constant]: 'Constant',
          [vscode.SymbolKind.String]: 'String',
          [vscode.SymbolKind.Number]: 'Number',
          [vscode.SymbolKind.Boolean]: 'Boolean',
          [vscode.SymbolKind.Array]: 'Array',
          [vscode.SymbolKind.Object]: 'Object',
          [vscode.SymbolKind.Key]: 'Key',
          [vscode.SymbolKind.Null]: 'Null',
          [vscode.SymbolKind.EnumMember]: 'EnumMember',
          [vscode.SymbolKind.Struct]: 'Struct',
          [vscode.SymbolKind.Event]: 'Event',
          [vscode.SymbolKind.Operator]: 'Operator',
          [vscode.SymbolKind.TypeParameter]: 'TypeParameter',
        };

        const text = `Found ${symbols.length} symbols matching "${query}":\n\n${symbols
          .map((symbol, index) => {
            const kind = symbolKindMap[symbol.kind] || 'Unknown';
            let result = `${index + 1}. **${symbol.name}** (${kind})\n`;
            result += `   📍 ${symbol.location.uri.toString()} (line ${symbol.location.range.start.line + 1})`;
            if (symbol.containerName) {
              result += `\n   📦 Container: ${symbol.containerName}`;
            }
            return result;
          })
          .join('\n\n')}`;

        return {
          content: [{ type: 'text', text }],
        };
      } catch (error) {
        throw new Error(
          `Failed to get workspace symbols: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
}
