import * as vscode from 'vscode';
import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { logger } from './logger';
import { createCoordinator, McpCoordinator } from './coordination/coordinator';
import { InstanceMode } from './coordination/types';

interface McpServerInstance {
  app: express.Application;
  server: any;
  port: number;
  transports: { [sessionId: string]: StreamableHTTPServerTransport };
  coordinator?: McpCoordinator;
  mode?: InstanceMode;
}

let serverInstance: McpServerInstance | null = null;

/**
 * Start MCP server with HTTP transport and coordination support
 */
export async function startMcpServer(
  context: vscode.ExtensionContext
): Promise<McpServerInstance> {
  if (serverInstance) {
    logger.info('MCP server already running', { 
      port: serverInstance.port,
      mode: serverInstance.mode
    });
    return serverInstance;
  }

  // Create Express app first
  const app = express();

  // Initialize coordination if enabled
  let coordinator: McpCoordinator | undefined;
  let mode: InstanceMode | undefined;
  
  try {
    coordinator = await createCoordinator(logger);
    mode = coordinator.getMode();
    
    // Pass context to coordinator for tool execution
    const coordinatorWithContext = coordinator as any;
    if (coordinatorWithContext.setContext) {
      coordinatorWithContext.setContext(context);
    }
    
    // If it's a master coordinator, pass the Express app so it can add coordination routes
    if (mode === InstanceMode.MASTER && coordinatorWithContext.setExpressApp) {
      coordinatorWithContext.setExpressApp(app);
      logger.info('Passed Express app to MasterCoordinator for route integration');
    }
    
    await coordinator.start();
    logger.info('MCP server coordination initialized', { mode, instanceId: coordinator.getInstanceId() });
  } catch (error) {
    logger.warn('Failed to initialize coordination, falling back to standalone mode', error);
    // Continue without coordination
  }
  app.use(express.json());

  // CORS configuration for browser-based clients
  app.use(
    cors({
      origin: '*', // Configure for production
      exposedHeaders: ['Mcp-Session-Id'],
      allowedHeaders: ['Content-Type', 'mcp-session-id'],
    })
  );

  const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

  // Handle POST requests for client-to-server communication
  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    logger.debug('MCP POST request', { 
      sessionId, 
      hasSession: !!sessionId && !!transports[sessionId],
      method: req.body?.method,
      isInitRequest: isInitializeRequest(req.body)
    });

    if (sessionId && transports[sessionId]) {
      // Reuse existing transport
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New initialization request
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: sessionId => {
          transports[sessionId] = transport;
          logger.debug('Session initialized', { sessionId });
        },
        enableDnsRebindingProtection: false, // Disabled for local development
      });

      // Clean up transport when closed
      transport.onclose = () => {
        if (transport.sessionId) {
          delete transports[transport.sessionId];
          logger.debug('Session closed', { sessionId: transport.sessionId });
        }
      };

      // Create and configure MCP server
      const mcpServer = createMcpServer(context, coordinator);
      await mcpServer.connect(transport);

      logger.info('New MCP session created');
    } else {
      // Invalid request
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: No valid session ID provided',
        },
        id: null,
      });
      return;
    }

    // Handle the request
    await transport.handleRequest(req, res, req.body);
  });

  // Reusable handler for GET and DELETE requests
  const handleSessionRequest = async (
    req: express.Request,
    res: express.Response
  ) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }

    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  };

  // Handle GET requests for server-to-client notifications via SSE
  app.get('/mcp', handleSessionRequest);

  // Handle DELETE requests for session termination
  app.delete('/mcp', handleSessionRequest);



  // Find available port based on coordination mode
  const vsConfig = vscode.workspace.getConfiguration('codebridge-mcp');
  const preferredPort = mode === InstanceMode.MASTER ? 
    vsConfig.get<number>('coordination.masterPort') || 9100 :
    vsConfig.get<number>('server.port') || 9100;
  const port = await findAvailablePort(preferredPort);

  // Health check endpoint
  app.get('/health', (_req, res) => {
    const healthData: any = {
      status: 'ok',
      workspace: getWorkspaceInfo(),
      sessions: Object.keys(transports).length,
      transport: 'streamable-http',
      endpoint: `http://127.0.0.1:${port}/mcp`,
    };

    // Add coordination information if available
    if (coordinator && mode) {
      healthData.coordination = {
        mode,
        instanceId: coordinator.getInstanceId(),
        enabled: true
      };
    } else {
      healthData.coordination = {
        mode: 'standalone',
        enabled: false
      };
    }

    res.json(healthData);
  });

  return new Promise((resolve, reject) => {
    const httpServer = app.listen(port, '127.0.0.1', (error?: any) => {
      if (error) {
        logger.error('Failed to start MCP server', {
          error: error.message,
          port,
          mode
        });
        reject(error);
        return;
      }

      serverInstance = { app, server: httpServer, port, transports, coordinator, mode };
      logger.info('MCP server started successfully', {
        port,
        mode,
        instanceId: coordinator?.getInstanceId(),
        endpoint: `http://127.0.0.1:${port}/mcp`,
      });
      resolve(serverInstance);
    });
  });
}

/**
 * Stop MCP server
 */
export async function stopMcpServer(): Promise<void> {
  if (!serverInstance) {
    return;
  }

  logger.info('Stopping MCP server', { 
    port: serverInstance.port, 
    mode: serverInstance.mode 
  });

  // Stop coordinator first if present
  if (serverInstance.coordinator) {
    try {
      await serverInstance.coordinator.stop();
    } catch (error) {
      logger.warn('Error stopping coordinator', error);
    }
  }

  // Close all transports
  for (const [sessionId, transport] of Object.entries(
    serverInstance.transports
  )) {
    transport.close();
    logger.debug('Closed transport', { sessionId });
  }

  // Close HTTP server
  return new Promise(resolve => {
    serverInstance!.server.close(() => {
      logger.info('MCP server stopped', { 
        port: serverInstance!.port, 
        mode: serverInstance!.mode 
      });
      serverInstance = null;
      resolve();
    });
  });
}

/**
 * Get current MCP server info
 */
export function getMcpServerInfo(): { 
  port: number; 
  endpoint: string;
  mode?: InstanceMode;
  instanceId?: string;
  coordination: boolean;
} | null {
  if (!serverInstance) {
    return null;
  }

  return {
    port: serverInstance.port,
    endpoint: `http://127.0.0.1:${serverInstance.port}/mcp`,
    mode: serverInstance.mode,
    instanceId: serverInstance.coordinator?.getInstanceId(),
    coordination: !!serverInstance.coordinator
  };
}

/**
 * Get current coordinator instance
 */
export function getMcpCoordinator(): McpCoordinator | null {
  return serverInstance?.coordinator || null;
}

/**
 * Create and configure MCP server with tools
 */
function createMcpServer(context: vscode.ExtensionContext, coordinator?: McpCoordinator): McpServer {
  const server = new McpServer({
    name: 'codebridge-mcp',
    version: context.extension.packageJSON.version || '1.0.0',
  });

  // Import and register tools
  registerAllTools(server, coordinator);

  return server;
}

/**
 * Register all MCP tools
 */
function registerAllTools(server: McpServer, coordinator?: McpCoordinator): void {
  // Import and register all tools
  const { registerDiagnosticsTool } = require('./tools/diagnostics');
  const { registerFileTools } = require('./tools/files');
  const { registerSelectionTool } = require('./tools/selection');
  const { registerReferencesTools } = require('./tools/references');
  const { registerSymbolsTool } = require('./tools/symbols');
  const { registerWorkspaceTools } = require('./tools/workspace');

  registerDiagnosticsTool(server, coordinator);
  registerFileTools(server, coordinator);
  registerSelectionTool(server, coordinator);
  registerReferencesTools(server, coordinator);
  registerSymbolsTool(server, coordinator);
  registerWorkspaceTools(server, coordinator); // New workspace-aware tools

  logger.debug('All MCP tools registered successfully');
}

/**
 * Get workspace information
 */
function getWorkspaceInfo() {
  const workspaceFile = vscode.workspace.workspaceFile;
  const workspace = vscode.workspace.workspaceFolders?.[0];

  if (workspaceFile) {
    return {
      type: 'multi-root',
      name:
        workspaceFile.path.split('/').pop()?.replace('.code-workspace', '') ||
        'Unknown',
      path: workspaceFile.fsPath,
    };
  } else if (workspace) {
    return {
      type: 'single-root',
      name: workspace.name,
      path: workspace.uri.fsPath,
    };
  }

  return {
    type: 'none',
    name: 'No workspace',
    path: null,
  };
}

/**
 * Find available port starting from given port
 */
async function findAvailablePort(startPort: number): Promise<number> {
  const net = await import('net');

  return new Promise(resolve => {
    const httpServer = net.createServer();

    httpServer.listen(startPort, '127.0.0.1', () => {
      const port = (httpServer.address() as any)?.port || startPort;
      httpServer.close(() => resolve(port));
    });

    httpServer.on('error', () => {
      // Port in use, try next one
      resolve(findAvailablePort(startPort + 1));
    });
  });
}
