import * as vscode from 'vscode';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerReferencesTools(
  server: McpServer,
  _coordinator?: any,
): void {
  // Find references tool
  server.registerTool(
    'find_references',
    {
      title: 'Find References',
      description:
        "Find all references to a symbol (variable, function, class, etc.) at a specific position. Essential for code refactoring, understanding code dependencies, and finding all usages of a symbol across the entire workspace. Uses VSCode's intelligent language server analysis. Prefer this for finding usages of classes, methods, functions etc.",
      inputSchema: {
        uri: z.string().describe('File URI containing the symbol'),
        position: z
          .object({
            line: z.number(),
            character: z.number(),
          })
          .describe('Position of the symbol (0-based)'),
        includeDeclaration: z
          .boolean()
          .optional()
          .describe('Whether to include the declaration in results'),
      },
    },
    async ({ uri, position, includeDeclaration = true }) => {
      try {
        const fileUri = vscode.Uri.parse(uri);
        const pos = new vscode.Position(position.line, position.character);

        const references = await vscode.commands.executeCommand<
          vscode.Location[]
        >('vscode.executeReferenceProvider', fileUri, pos, includeDeclaration);

        if (!references || references.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No references found for symbol at line ${position.line + 1}, character ${position.character + 1}.`,
              },
            ],
          };
        }

        const text = `Found ${references.length} references:\n\n${references
          .map(
            (ref, index) =>
              `${index + 1}. **${ref.uri.toString()}** (line ${ref.range.start.line + 1}, col ${ref.range.start.character + 1})`,
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
    },
  );

  // Find definition tool
  server.registerTool(
    'find_definition',
    {
      title: 'Find Definition',
      description:
        'Find definition(s) of a symbol (variable, function, class, import, etc.) at a specific position. Critical for code navigation, understanding code flow, and jumping to where symbols are declared or implemented. Supports Go-to-Definition functionality.',
      inputSchema: {
        uri: z.string().describe('File URI containing the symbol'),
        position: z
          .object({
            line: z.number(),
            character: z.number(),
          })
          .describe('Position of the symbol (0-based)'),
      },
    },
    async ({ uri, position }) => {
      try {
        const fileUri = vscode.Uri.parse(uri);
        const pos = new vscode.Position(position.line, position.character);

        const definitions = await vscode.commands.executeCommand<
          (vscode.Location | vscode.LocationLink)[]
        >('vscode.executeDefinitionProvider', fileUri, pos);

        if (!definitions || definitions.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No definition found for symbol at line ${position.line + 1}, character ${position.character + 1}.`,
              },
            ],
          };
        }

        const locations = definitions.map((def) => {
          if ('uri' in def) {
            // vscode.Location
            return { uri: def.uri, range: def.range };
          } else {
            // vscode.LocationLink
            return { uri: def.targetUri, range: def.targetRange };
          }
        });

        const text = `Found ${locations.length} definition${locations.length > 1 ? 's' : ''}:\n\n${locations
          .map(
            (loc, index) =>
              `${index + 1}. **${loc.uri.toString()}** (line ${loc.range.start.line + 1}, col ${loc.range.start.character + 1})`,
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
    },
  );
}
