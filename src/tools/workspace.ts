import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerWorkspaceTools(
  server: McpServer,
  coordinator?: any,
): void {
  // Get workspaces tool - shows all available workspaces/instances
  server.registerTool(
    'get_workspaces',
    {
      title: 'Get Available Workspaces',
      description:
        'Get list of all available VSCode workspaces/instances. Shows workspace names, paths, and instance status. Use this to understand which workspaces are available before targeting specific ones with other tools. Essential for multi-workspace development workflows.',
      inputSchema: {},
    },
    async (args) => {
      if (coordinator && coordinator.handleToolCall) {
        // Route through coordinator
        return await coordinator.handleToolCall('get_workspaces', args);
      } else {
        // Fallback for standalone mode - just show current workspace
        const vscode = require('vscode');
        const workspaceFile = vscode.workspace.workspaceFile;
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const firstFolder = workspaceFolders?.[0];

        let workspaceName = 'No workspace';
        let workspacePath = process.cwd();
        let workspaceType = 'none';
        let folders: Array<{ name: string; path: string }> = [];

        if (workspaceFile && workspaceFolders) {
          // Multi-folder workspace with .code-workspace file
          workspaceName =
            workspaceFile.path
              .split('/')
              .pop()
              ?.replace('.code-workspace', '') || 'Unknown Workspace';
          workspacePath = workspaceFile.path;
          workspaceType = 'multi-folder';
          folders = workspaceFolders.map((folder: any) => ({
            name: folder.name,
            path: folder.uri.fsPath,
          }));
        } else if (firstFolder) {
          // Single folder workspace
          workspaceName = firstFolder.name;
          workspacePath = firstFolder.uri.fsPath;
          workspaceType = 'single-folder';
          folders = [
            {
              name: firstFolder.name,
              path: firstFolder.uri.fsPath,
            },
          ];
        }

        // Generate text with folder information
        let text = `Available workspaces (1 total):\n\n**${workspaceName}** (standalone)\n  • Path: ${workspacePath}\n  • Status: active`;

        if (folders.length > 0) {
          if (workspaceType === 'multi-folder') {
            text += `\n  • Folders (${folders.length}):`;
            folders.forEach((folder) => {
              text += `\n    - ${folder.name} (${folder.path})`;
            });
          } else if (workspaceType === 'single-folder') {
            text += `\n  • Folder: ${folders[0].name}`;
          }
        }

        return {
          text: text,
          workspaces: [
            {
              instanceId: 'standalone',
              name: workspaceName,
              path: workspacePath,
              type: 'standalone',
              status: 'active',
              workspaceType: workspaceType,
              folders: folders,
            },
          ],
        };
      }
    },
  );
}
