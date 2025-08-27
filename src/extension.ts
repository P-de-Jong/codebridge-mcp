import * as vscode from 'vscode';
import { startMcpServer, stopMcpServer, getMcpServerInfo, getMcpCoordinator } from './mcp-server';
import { logger } from './logger';

let mcpServerInstance: any = null;

export async function activate(context: vscode.ExtensionContext) {
  console.log('CodeBridge MCP extension is being activated');

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('codebridge-mcp.start', async () => {
      try {
        if (mcpServerInstance) {
          vscode.window.showInformationMessage('MCP server is already running');
          return;
        }

        mcpServerInstance = await startMcpServer(context);
        const info = getMcpServerInfo();

        if (info) {
          vscode.window.showInformationMessage(
            `MCP server started on port ${info.port}. Endpoint: ${info.endpoint}`
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Failed to start MCP server', { error: message });
        vscode.window.showErrorMessage(
          `Failed to start MCP server: ${message}`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codebridge-mcp.stop', async () => {
      try {
        if (!mcpServerInstance) {
          vscode.window.showInformationMessage('MCP server is not running');
          return;
        }

        await stopMcpServer();
        mcpServerInstance = null;
        vscode.window.showInformationMessage('MCP server stopped');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Failed to stop MCP server', { error: message });
        vscode.window.showErrorMessage(`Failed to stop MCP server: ${message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codebridge-mcp.status', () => {
      const info = getMcpServerInfo();

      if (info) {
        // Determine workspace name - prefer workspace file over first folder
        const workspaceFile = vscode.workspace.workspaceFile;
        const workspace = vscode.workspace.workspaceFolders?.[0];
        const workspaceName = workspaceFile
          ? workspaceFile.path
              .split('/')
              .pop()
              ?.replace('.code-workspace', '') || 'Unknown Workspace'
          : workspace?.name || 'No workspace';

        vscode.window.showInformationMessage(
          `MCP Server Status: Running\nWorkspace: ${workspaceName}\nEndpoint: ${info.endpoint}\nPort: ${info.port}`
        );
      } else {
        vscode.window.showInformationMessage(
          'MCP Server Status: Not running\nUse "CodeBridge MCP: Start Server" to start'
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codebridge-mcp.toggleDebug', () => {
      const config = vscode.workspace.getConfiguration('codebridge-mcp');
      const currentDebug = config.get<boolean>('debug.enableLogging') || false;
      const newDebug = !currentDebug;

      config
        .update(
          'debug.enableLogging',
          newDebug,
          vscode.ConfigurationTarget.Global
        )
        .then(() => {
          logger.setDebugMode(newDebug);
          vscode.window.showInformationMessage(
            `Debug logging ${newDebug ? 'enabled' : 'disabled'}. Log file: ${logger.isDebugEnabled ? '~/.codebridge-mcp/codebridge-mcp-extension.log' : 'disabled'}`
          );
        });
    })
  );

  // Coordination commands
  context.subscriptions.push(
    vscode.commands.registerCommand('codebridge-mcp.showCoordinationStatus', async () => {
      try {
        const coordinator = getMcpCoordinator();
        const serverInfo = getMcpServerInfo();
        
        if (!coordinator || !serverInfo) {
          vscode.window.showInformationMessage(
            'MCP Server Status: Not running or coordination disabled\nUse "CodeBridge MCP: Start Server" to start'
          );
          return;
        }

        const mode = coordinator.getMode();
        const instanceId = coordinator.getInstanceId();
        const workers = (coordinator as any).getWorkers?.() || [];
        
        const statusMessage = [
          `MCP Coordination Status: Running`,
          `Mode: ${mode}`,
          `Instance ID: ${instanceId}`,
          `Port: ${serverInfo.port}`,
          `Connected Workers: ${workers.length}`,
          workers.length > 0 ? `Worker IDs: ${workers.map((w: any) => w.id).join(', ')}` : ''
        ].filter(Boolean).join('\n');

        vscode.window.showInformationMessage(statusMessage);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Failed to get coordination status', { error: message });
        vscode.window.showErrorMessage(`Failed to get coordination status: ${message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codebridge-mcp.listInstances', async () => {
      try {
        const coordinator = getMcpCoordinator();
        
        if (!coordinator) {
          vscode.window.showInformationMessage(
            'Coordination not enabled or server not running'
          );
          return;
        }

        const mode = coordinator.getMode();
        const instanceId = coordinator.getInstanceId();
        const workers = (coordinator as any).getWorkers?.() || [];
        
        if (mode === 'master') {
          const instances = [
            `🏛️  Master: ${instanceId} (this instance)`,
            ...workers.map((worker: any, index: number) => 
              `👷 Worker ${index + 1}: ${worker.id} (${worker.workspaces?.length || 0} workspaces)`
            )
          ];
          
          vscode.window.showQuickPick(instances, {
            placeHolder: `Connected Instances (${instances.length} total)`,
            canPickMany: false
          });
        } else {
          vscode.window.showInformationMessage(
            `Instance Mode: ${mode}\nInstance ID: ${instanceId}\nThis is a worker instance connected to a master`
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Failed to list instances', { error: message });
        vscode.window.showErrorMessage(`Failed to list instances: ${message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codebridge-mcp.forceMasterMode', async () => {
      try {
        const coordinator = getMcpCoordinator();
        
        if (!coordinator) {
          vscode.window.showWarningMessage('MCP server not running or coordination disabled');
          return;
        }

        const currentMode = coordinator.getMode();
        if (currentMode === 'master') {
          vscode.window.showInformationMessage('Already running in master mode');
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          'Force master mode? This will override coordination detection and may cause conflicts if another master exists.',
          'Force Master',
          'Cancel'
        );

        if (confirm === 'Force Master') {
          await (coordinator as any).forceMasterMode?.();
          vscode.window.showInformationMessage('Forced to master mode. Server restart recommended.');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Failed to force master mode', { error: message });
        vscode.window.showErrorMessage(`Failed to force master mode: ${message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codebridge-mcp.resetCoordination', async () => {
      try {
        const confirm = await vscode.window.showWarningMessage(
          'Reset coordination system? This will restart the server and re-detect the coordination mode.',
          'Reset',
          'Cancel'
        );

        if (confirm === 'Reset') {
          await vscode.commands.executeCommand('codebridge-mcp.stop');
          await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
          await vscode.commands.executeCommand('codebridge-mcp.start');
          vscode.window.showInformationMessage('Coordination system reset and server restarted');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Failed to reset coordination', { error: message });
        vscode.window.showErrorMessage(`Failed to reset coordination: ${message}`);
      }
    })
  );

  // Auto-start server if enabled
  const config = vscode.workspace.getConfiguration('codebridge-mcp');
  const autoStart = config.get<boolean>('server.autoStart') !== false; // Default to true

  if (autoStart) {
    try {
      mcpServerInstance = await startMcpServer(context);
      const info = getMcpServerInfo();

      if (info) {
        console.log(`MCP server auto-started on port ${info.port}`);
        logger.info('MCP server auto-started', info);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Failed to auto-start MCP server:', message);
      logger.error('Failed to auto-start MCP server', { error: message });

      vscode.window
        .showWarningMessage(
          'Failed to auto-start MCP server. Use "CodeBridge MCP: Start Server" command to start manually.',
          'Show Error'
        )
        .then(selection => {
          if (selection === 'Show Error') {
            vscode.window.showErrorMessage(`MCP Server Error: ${message}`);
          }
        });
    }
  }

  // Listen for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('codebridge-mcp')) {
        vscode.window
          .showInformationMessage(
            'CodeBridge MCP configuration changed. Restart the server to apply changes.',
            'Restart Server'
          )
          .then(selection => {
            if (selection === 'Restart Server') {
              vscode.commands
                .executeCommand('codebridge-mcp.stop')
                .then(() =>
                  vscode.commands.executeCommand('codebridge-mcp.start')
                );
            }
          });
      }
    })
  );

  console.log('CodeBridge MCP extension activated successfully');
}

export async function deactivate() {
  if (mcpServerInstance) {
    try {
      await stopMcpServer();
      mcpServerInstance = null;
      console.log('MCP server stopped during deactivation');
    } catch (error) {
      console.error('Error stopping MCP server during deactivation:', error);
    }
  }
  console.log('CodeBridge MCP extension deactivated');
}
