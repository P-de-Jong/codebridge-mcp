import express from 'express';
import * as http from 'http';
import * as path from 'path';
import { McpCoordinator } from './coordinator';
import {
  WorkerInfo,
  MasterState,
  InstanceMode,
  CoordinationConfig,
  RegistrationRequest,
  RegistrationResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  HealthCheckResponse,
  MasterStatus,
  ToolCallLog,
  createMasterState,
  TOOL_ROUTING_STRATEGY,
} from './types';
import { ExtensionLogger } from '../logger';
import {
  LocalToolExecutor,
  RemoteToolExecutor,
  ToolExecutor,
} from './toolExecutor';

export class MasterCoordinator extends McpCoordinator {
  private state: MasterState;
  private coordinationServer: express.Application | null = null;
  private coordinationHttpServer: http.Server | null = null;
  private heartbeatChecker: NodeJS.Timeout | null = null;
  private localExecutor: ToolExecutor | null = null;
  private context: any = null; // Will be set when available
  private externalApp: express.Application | null = null;
  private extensionVersion: string = '0.1.0';

  constructor(logger: ExtensionLogger, config: CoordinationConfig) {
    super(logger, config);
    this.mode = InstanceMode.MASTER;
    this.state = createMasterState(this.instanceId);
    this.loadExtensionVersion();
  }

  private loadExtensionVersion(): void {
    try {
      // Try to load version from package.json
      // Look for package.json in the extension root (going up from src/coordination/)
      const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');

      if (require('fs').existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(
          require('fs').readFileSync(packageJsonPath, 'utf8'),
        );
        this.extensionVersion = packageJson.version || '0.1.0';
        this.logger.debug('Loaded extension version from package.json', {
          version: this.extensionVersion,
          packagePath: packageJsonPath,
        });
      } else {
        this.logger.debug('package.json not found, using default version', {
          searchedPath: packageJsonPath,
          defaultVersion: this.extensionVersion,
        });
      }
    } catch (error) {
      this.logger.warn('Failed to load extension version from package.json', {
        error: error instanceof Error ? error.message : String(error),
        fallbackVersion: this.extensionVersion,
      });
    }
  }

  setExpressApp(app: express.Application): void {
    this.externalApp = app;
  }

  async start(): Promise<void> {
    this.logger.info('Starting Master Coordinator', {
      instanceId: this.instanceId,
      port: this.config.masterPort,
    });

    if (this.externalApp) {
      // Use external Express app for coordination routes
      this.setupCoordinationRoutes(this.externalApp);
      this.logger.info('Master coordination routes set up on external app');
    } else {
      // Fallback to own server if no external app provided
      await this.startCoordinationServer();
    }

    this.startHeartbeatChecker();

    this.emitEvent({
      type: 'master_changed',
      instanceId: this.instanceId,
      timestamp: Date.now(),
      data: { port: this.config.masterPort },
    });
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping Master Coordinator');

    if (this.heartbeatChecker) {
      clearInterval(this.heartbeatChecker);
      this.heartbeatChecker = null;
    }

    // Notify workers of shutdown
    await this.broadcastShutdown();

    if (this.coordinationHttpServer) {
      this.coordinationHttpServer.close();
      this.coordinationHttpServer = null;
    }

    this.coordinationServer = null;
  }

  async handleToolCall(tool: string, params: any): Promise<any> {
    const startTime = Date.now();
    let result: any;
    let error: string | undefined;
    let routedTo: string | undefined;

    try {
      result = await this.routeToolCall(tool, params);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      // Log tool call for monitoring
      const toolCall: ToolCallLog = {
        id: `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        tool,
        params,
        result: error ? undefined : result,
        error,
        timestamp: startTime,
        duration: Date.now() - startTime,
        routedTo,
      };

      this.state.toolCallHistory.push(toolCall);

      // Keep only last 100 tool calls
      if (this.state.toolCallHistory.length > 100) {
        this.state.toolCallHistory.shift();
      }

      // Update performance metrics
      this.updatePerformanceMetrics(toolCall);
    }

    return result;
  }

  private async startCoordinationServer(): Promise<void> {
    this.coordinationServer = express();
    this.coordinationServer.use(express.json());

    this.setupCoordinationRoutes();

    return new Promise((resolve, reject) => {
      this.coordinationHttpServer = this.coordinationServer!.listen(
        this.config.masterPort,
        'localhost',
        () => {
          this.logger.info(
            `Master coordination server listening on port ${this.config.masterPort}`,
          );
          resolve();
        },
      );

      this.coordinationHttpServer!.on('error', (error) => {
        this.logger.error('Failed to start coordination server', error);
        reject(error);
      });
    });
  }

  private setupCoordinationRoutes(externalApp?: express.Application): void {
    const app = externalApp || this.coordinationServer!;

    // Coordination health check endpoint
    app.get('/coordination/health', (_req, res) => {
      const healthResponse: HealthCheckResponse = {
        status: MasterStatus.HEALTHY,
        instanceId: this.instanceId,
        uptime: Date.now() - this.state.startedAt,
        workerCount: this.state.registeredWorkers.size,
        version: this.extensionVersion,
        timestamp: Date.now(),
      };
      res.json(healthResponse);
    });

    // Worker registration
    app.post('/coordination/workers/register', (req, res) => {
      try {
        const registrationRequest: RegistrationRequest = req.body;
        const response = this.registerWorker(registrationRequest);
        res.json(response);
      } catch (error) {
        this.logger.error('Worker registration failed', error);
        const response: RegistrationResponse = {
          success: false,
          instanceId: '',
          masterInstanceId: this.instanceId,
          heartbeatInterval: this.config.heartbeatInterval,
          error: error instanceof Error ? error.message : String(error),
        };
        res.status(400).json(response);
      }
    });

    // Worker deregistration
    app.delete('/coordination/workers/:instanceId', (req, res) => {
      const instanceId = req.params.instanceId;
      this.deregisterWorker(instanceId);
      res.json({ success: true });
    });

    app.post('/coordination/workers/:instanceId/heartbeat', (req, res) => {
      try {
        const instanceId = req.params.instanceId;
        const heartbeatRequest: HeartbeatRequest = req.body;
        const response = this.handleHeartbeat(instanceId, heartbeatRequest);
        res.json(response);
      } catch (error) {
        const response: HeartbeatResponse = {
          success: false,
          masterStatus: MasterStatus.HEALTHY,
          shouldReregister: true,
        };
        res.status(400).json(response);
      }
    });

    // Get workers list (debug endpoint)
    app.get('/coordination/workers', (_req, res) => {
      const workers = Array.from(this.state.registeredWorkers.values());
      res.json({ workers });
    });

    app.post('/coordination/tools/:toolName', async (req, res) => {
      try {
        const toolName = req.params.toolName;
        const params = req.body;

        // This will be used by workers to execute tools on master
        // For Phase 1, we'll implement basic forwarding
        const result = await this.executeLocalTool(toolName, params);
        res.json({ success: true, result });
      } catch (error) {
        this.logger.error('Tool execution failed', error);
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  private registerWorker(request: RegistrationRequest): RegistrationResponse {
    this.logger.info('Registering worker', request);

    const workerInfo: WorkerInfo = {
      instanceId: request.instanceId,
      workspaceName: request.workspaceName,
      workspacePath: request.workspacePath,
      port: request.port,
      capabilities: request.capabilities,
      lastSeen: Date.now(),
      status: 'active',
      registeredAt: Date.now(),
      version: request.version,
    };

    this.state.registeredWorkers.set(request.instanceId, workerInfo);

    // Update workspace routing
    this.updateWorkspaceRouting(workerInfo);

    this.emitEvent({
      type: 'worker_registered',
      instanceId: request.instanceId,
      timestamp: Date.now(),
      data: workerInfo,
    });

    return {
      success: true,
      instanceId: request.instanceId,
      masterInstanceId: this.instanceId,
      heartbeatInterval: this.config.heartbeatInterval,
    };
  }

  private deregisterWorker(instanceId: string): void {
    const worker = this.state.registeredWorkers.get(instanceId);
    if (worker) {
      this.logger.info('Deregistering worker', {
        instanceId,
        workspaceName: worker.workspaceName,
      });
      this.state.registeredWorkers.delete(instanceId);

      // Clean up workspace routing
      this.cleanupWorkspaceRouting(instanceId);

      this.emitEvent({
        type: 'worker_disconnected',
        instanceId,
        timestamp: Date.now(),
        data: worker,
      });
    }
  }

  private handleHeartbeat(
    instanceId: string,
    request: HeartbeatRequest,
  ): HeartbeatResponse {
    const worker = this.state.registeredWorkers.get(instanceId);
    if (!worker) {
      return {
        success: false,
        masterStatus: MasterStatus.HEALTHY,
        shouldReregister: true,
      };
    }

    // Update worker status
    worker.lastSeen = request.timestamp;
    worker.status = request.status;

    return {
      success: true,
      masterStatus: MasterStatus.HEALTHY,
    };
  }

  private startHeartbeatChecker(): void {
    this.heartbeatChecker = setInterval(() => {
      this.checkWorkerHeartbeats();
    }, this.config.heartbeatInterval);
  }

  private checkWorkerHeartbeats(): void {
    const now = Date.now();
    const timeoutThreshold = this.config.heartbeatInterval * 3; // 3 missed heartbeats

    for (const [instanceId, worker] of this.state.registeredWorkers.entries()) {
      if (now - worker.lastSeen > timeoutThreshold) {
        this.logger.warn('Worker heartbeat timeout', {
          instanceId,
          workspaceName: worker.workspaceName,
          lastSeen: new Date(worker.lastSeen).toISOString(),
        });
        this.deregisterWorker(instanceId);
      }
    }
  }

  private async routeToolCall(tool: string, params: any): Promise<any> {
    this.logger.debug('Routing tool call', {
      tool,
      workerCount: this.state.registeredWorkers.size,
    });

    if (TOOL_ROUTING_STRATEGY.workspace_specific.includes(tool)) {
      // Route to appropriate worker based on file path or workspace
      const targetWorker = this.findTargetWorker(params);
      if (targetWorker) {
        this.logger.debug('Routing to specific worker', {
          tool,
          worker: targetWorker.instanceId,
          workspace: targetWorker.workspaceName,
        });
        return await this.callWorkerTool(targetWorker, tool, params);
      } else {
        this.logger.debug('No specific worker found, executing locally', {
          tool,
        });
      }
    }

    if (TOOL_ROUTING_STRATEGY.active_context.includes(tool)) {
      // Route to the most recently active worker, or local if none
      const activeWorker = this.findActiveWorker();
      if (activeWorker) {
        this.logger.debug('Routing to active worker', {
          tool,
          worker: activeWorker.instanceId,
          workspace: activeWorker.workspaceName,
        });
        return await this.callWorkerTool(activeWorker, tool, params);
      }
    }

    if (TOOL_ROUTING_STRATEGY.aggregated.includes(tool)) {
      // Aggregate results from all workers including local
      this.logger.debug('Aggregating results from all workers', {
        tool,
        workerCount: this.state.registeredWorkers.size,
      });
      return await this.aggregateFromAllWorkers(tool, params);
    }

    // Default: execute locally
    this.logger.debug('Executing tool locally', { tool });
    return await this.executeLocalTool(tool, params);
  }

  private findTargetWorker(params: any): WorkerInfo | null {
    // Enhanced workspace targeting - check for explicit workspace specification
    if (params.workspace) {
      const targetWorkspace = params.workspace;
      this.logger.debug('Finding worker for specified workspace', {
        workspace: targetWorkspace,
      });

      // Try to match by workspace name first
      for (const [, worker] of this.state.registeredWorkers.entries()) {
        if (
          worker.workspaceName === targetWorkspace ||
          worker.workspacePath === targetWorkspace
        ) {
          this.logger.debug('Found worker for workspace', {
            workspace: targetWorkspace,
            worker: worker.instanceId,
            matched: worker.workspaceName,
          });
          return worker;
        }
      }

      // If workspace specified but not found, return null (will fall back to local)
      this.logger.debug(
        'Specified workspace not found, will use local execution',
        { workspace: targetWorkspace },
      );
      return null;
    }

    // File-based routing for workspace-specific tools
    if (params.uri) {
      const fileUri = params.uri;
      this.logger.debug('Finding worker for file URI', { uri: fileUri });

      // Try to match the file path to a worker's workspace
      for (const [, worker] of this.state.registeredWorkers.entries()) {
        if (this.isFileInWorkspace(fileUri, worker.workspacePath)) {
          this.logger.debug('Found worker for file', {
            file: fileUri,
            worker: worker.instanceId,
            workspace: worker.workspacePath,
          });
          return worker;
        }
      }
    }

    // For get_selection without workspace specified, use the most active worker
    const activeWorker = this.findActiveWorker();
    if (activeWorker) {
      this.logger.debug('Using most active worker', {
        worker: activeWorker.instanceId,
        workspace: activeWorker.workspaceName,
      });
      return activeWorker;
    }

    // Fallback: return any available worker
    const workers = Array.from(this.state.registeredWorkers.values());
    return workers.length > 0 ? workers[0] : null;
  }

  private findActiveWorker(): WorkerInfo | null {
    // Find the most recently active worker
    const activeWorkers = Array.from(this.state.registeredWorkers.values())
      .filter((worker) => worker.status === 'active')
      .sort((a, b) => b.lastSeen - a.lastSeen);

    return activeWorkers.length > 0 ? activeWorkers[0] : null;
  }

  private isFileInWorkspace(fileUri: string, workspacePath: string): boolean {
    try {
      // Convert URI to file path for comparison
      const filePath = fileUri.startsWith('file://')
        ? decodeURIComponent(fileUri.replace('file://', ''))
        : fileUri;

      // Normalize paths for comparison
      const normalizedFilePath = path.resolve(filePath);
      const normalizedWorkspacePath = path.resolve(workspacePath);

      return normalizedFilePath.startsWith(normalizedWorkspacePath);
    } catch (error) {
      this.logger.debug('Error matching file to workspace', {
        fileUri,
        workspacePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private async callWorkerTool(
    worker: WorkerInfo,
    tool: string,
    params: any,
  ): Promise<any> {
    // Phase 2: Actual HTTP calls to workers
    try {
      const remoteExecutor = new RemoteToolExecutor(this.logger, worker);
      const result = await remoteExecutor.executeTool(tool, params);
      return result;
    } catch (error) {
      this.logger.warn(
        'Worker tool call failed, falling back to local execution',
        {
          worker: worker.instanceId,
          tool,
          error: error instanceof Error ? error.message : String(error),
        },
      );

      // Fallback to local execution
      return await this.executeLocalTool(tool, params);
    }
  }

  private async aggregateFromAllWorkers(
    tool: string,
    params: any,
  ): Promise<any> {
    // Phase 2: Actual result aggregation from workers
    const workers = Array.from(this.state.registeredWorkers.values());
    const promises: Promise<any>[] = [];

    this.logger.info('Starting aggregation from all workers', {
      tool,
      workerCount: workers.length,
      workers: workers.map((w) => ({
        id: w.instanceId,
        name: w.workspaceName,
        port: w.port,
      })),
    });

    // Collect results from all workers
    for (const worker of workers) {
      const remoteExecutor = new RemoteToolExecutor(this.logger, worker);
      promises.push(
        remoteExecutor.executeTool(tool, params).catch((error) => {
          this.logger.warn('Worker failed during aggregation', {
            worker: worker.instanceId,
            tool,
            error: error instanceof Error ? error.message : String(error),
          });
          return null; // Return null for failed workers
        }),
      );
    }

    // Add local execution to the mix
    promises.push(
      this.executeLocalTool(tool, params).catch((error) => {
        this.logger.warn('Local execution failed during aggregation', {
          tool,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }),
    );

    // Wait for all results
    const results = await Promise.allSettled(promises);
    const validResults = results
      .map((result) => (result.status === 'fulfilled' ? result.value : null))
      .filter((result) => result !== null);

    this.logger.info('Aggregation results collected', {
      tool,
      totalPromises: promises.length,
      fulfilledResults: results.filter((r) => r.status === 'fulfilled').length,
      validResults: validResults.length,
      results: validResults.map((r, i) => ({
        index: i,
        hasContent: !!r?.content,
      })),
    });

    if (validResults.length === 0) {
      throw new Error(
        `All workers and local execution failed for tool: ${tool}`,
      );
    }

    // Aggregate the results based on the tool type
    return this.mergeToolResults(tool, validResults);
  }

  private mergeToolResults(tool: string, results: any[]): any {
    switch (tool) {
      case 'get_open_files':
        return this.mergeOpenFilesResults(results);

      case 'get_workspace_symbols':
        return this.mergeWorkspaceSymbolsResults(results);

      case 'search_files':
        return this.mergeSearchResults(results);

      case 'get_workspaces':
        return this.mergeWorkspacesResults(results);

      case 'get_instances':
        return this.mergeInstancesResults(results);

      default:
        // For other tools, just return the first valid result
        return results[0];
    }
  }

  private mergeOpenFilesResults(results: any[]): any {
    const allFiles: any[] = [];
    const workspaceNames: string[] = [];

    for (const result of results) {
      if (result?.content?.[0]?.text) {
        const text = result.content[0].text;
        if (text.includes('Found ') && text.includes('open files:')) {
          // Extract file information from the text
          const lines = text
            .split('\n')
            .filter((line: string) => line.includes('URI:'));
          allFiles.push(...lines);

          // Extract workspace info if available
          const match = text.match(/Found (\d+) open files/);
          if (match) {
            workspaceNames.push(`Workspace with ${match[1]} files`);
          }
        }
      }
    }

    if (allFiles.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No files are currently open across all instances',
          },
        ],
      };
    }

    const text = `Found ${allFiles.length} open files across ${workspaceNames.length} workspaces:\n\n${allFiles.join('\n')}`;
    return {
      content: [{ type: 'text', text }],
    };
  }

  private mergeWorkspaceSymbolsResults(results: any[]): any {
    const allSymbols: string[] = [];

    for (const result of results) {
      if (result?.content?.[0]?.text) {
        const text = result.content[0].text;
        const symbolLines = text
          .split('\n')
          .filter((line: string) => line.startsWith('**'));
        allSymbols.push(...symbolLines);
      }
    }

    if (allSymbols.length === 0) {
      return (
        results[0] || {
          content: [
            {
              type: 'text',
              text: 'No symbols found across all workspaces',
            },
          ],
        }
      );
    }

    // Remove duplicates and sort
    const uniqueSymbols = [...new Set(allSymbols)].slice(0, 100); // Limit to 100 results

    const text = `Found ${uniqueSymbols.length} symbols across all workspaces:\n\n${uniqueSymbols.join('\n')}`;
    return {
      content: [{ type: 'text', text }],
    };
  }

  private mergeSearchResults(results: any[]): any {
    // Similar to workspace symbols, but for search results
    const allResults: string[] = [];

    for (const result of results) {
      if (result?.content?.[0]?.text) {
        const text = result.content[0].text;
        const resultLines = text
          .split('\n')
          .filter((line: string) => line.trim().length > 0);
        allResults.push(...resultLines);
      }
    }

    if (allResults.length === 0) {
      return (
        results[0] || {
          content: [
            {
              type: 'text',
              text: 'No search results found across all workspaces',
            },
          ],
        }
      );
    }

    const text = `Search results from all workspaces:\n\n${allResults.join('\n')}`;
    return {
      content: [{ type: 'text', text }],
    };
  }

  private mergeWorkspacesResults(results: any[]): any {
    const allWorkspaces: string[] = [];
    let totalWorkspaces = 0;

    this.logger.debug('Merging workspace results', {
      resultCount: results.length,
      results: results.map((r) => ({ hasContent: !!r?.content?.[0]?.text })),
    });

    for (const result of results) {
      if (result?.content?.[0]?.text) {
        const text = result.content[0].text;
        // Extract workspace entries - each result should contain workspace info
        const workspaceLines = text
          .split('\n')
          .filter(
            (line: string) => line.startsWith('**') || line.startsWith('  •'),
          );
        if (workspaceLines.length > 0) {
          allWorkspaces.push(...workspaceLines);
          totalWorkspaces++;
        }
      }
    }

    if (allWorkspaces.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No workspaces are currently available',
          },
        ],
      };
    }

    const text =
      `Available workspaces (${totalWorkspaces} total):\n\n${allWorkspaces.join('\n')}\n\n` +
      `Use the workspace name or path in other tools to target specific workspaces. ` +
      `For context-sensitive tools like get_selection, specify the workspace to get results from that specific instance.`;

    return {
      content: [{ type: 'text', text }],
    };
  }

  private mergeInstancesResults(results: any[]): any {
    const allInstances: string[] = [];
    let totalInstances = 0;

    this.logger.debug('Merging instance results', {
      resultCount: results.length,
      results: results.map((r) => ({ hasContent: !!r?.content?.[0]?.text })),
    });

    for (const result of results) {
      if (result?.content?.[0]?.text) {
        const text = result.content[0].text;
        // Extract instance entries - each result should contain instance info
        const instanceLines = text
          .split('\n')
          .filter(
            (line: string) => line.startsWith('**') || line.startsWith('  •'),
          );
        if (instanceLines.length > 0) {
          allInstances.push(...instanceLines);
          totalInstances++;
        }
      }
    }

    if (allInstances.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No instances are currently connected',
          },
        ],
      };
    }

    const text =
      `Connected instances (${totalInstances} total):\n\n${allInstances.join('\n')}\n\n` +
      `Master coordinates all workers and handles tool routing. Workers execute tools within their specific workspaces.`;

    return {
      content: [{ type: 'text', text }],
    };
  }

  private async executeLocalTool(tool: string, params: any): Promise<any> {
    // Handle special master-only tools first
    if (tool === 'get_workspaces') {
      return await this.executeGetMasterWorkspace();
    }

    if (tool === 'get_instances') {
      return await this.executeGetMasterInstance();
    }

    // Phase 2: Actual local tool execution
    if (!this.localExecutor) {
      if (this.context) {
        this.localExecutor = new LocalToolExecutor(this.logger, this.context);
      } else {
        throw new Error(
          'Local tool executor not initialized - no context available',
        );
      }
    }

    return await this.localExecutor.executeTool(tool, params);
  }

  private async executeGetMasterWorkspace(): Promise<any> {
    // This is called as part of aggregation - return just the master workspace info
    const masterWorkspace = this.getCurrentWorkspaceInfo();

    const masterWorkspaceData = {
      instanceId: this.instanceId,
      name: masterWorkspace.name,
      path: masterWorkspace.path,
      type: 'master',
      status: 'active',
      workspaceType: masterWorkspace.type || 'unknown',
      folders: masterWorkspace.folders || [],
    };

    return {
      content: [
        {
          type: 'text',
          text:
            `**${masterWorkspaceData.name}** (master)\n` +
            `  • Path: ${masterWorkspaceData.path}\n` +
            `  • Instance: ${masterWorkspaceData.instanceId}\n` +
            `  • Status: ${masterWorkspaceData.status}\n` +
            `  • Type: ${masterWorkspaceData.workspaceType}`,
        },
      ],
    };
  }

  private async executeGetMasterInstance(): Promise<any> {
    // Return this master's instance info for aggregation
    const uptime = Date.now() - this.state.startedAt;
    const uptimeStr = this.formatUptime(uptime);

    const instanceInfo = {
      instanceId: this.instanceId,
      type: 'master',
      status: 'active',
      port: this.config.masterPort,
      uptime: uptimeStr,
      version: this.extensionVersion,
      workerCount: this.state.registeredWorkers.size,
      startedAt: new Date(this.state.startedAt).toISOString(),
      performanceMetrics: this.state.performanceMetrics,
    };

    return {
      content: [
        {
          type: 'text',
          text:
            `**${instanceInfo.instanceId}** (master)\n` +
            `  • Status: ${instanceInfo.status}\n` +
            `  • Port: ${instanceInfo.port}\n` +
            `  • Uptime: ${instanceInfo.uptime}\n` +
            `  • Version: ${instanceInfo.version}\n` +
            `  • Connected workers: ${instanceInfo.workerCount}\n` +
            `  • Started: ${instanceInfo.startedAt}\n` +
            `  • Total tool calls: ${instanceInfo.performanceMetrics.totalToolCalls}\n` +
            `  • Success rate: ${(instanceInfo.performanceMetrics.successRate * 100).toFixed(1)}%\n` +
            `  • Avg response time: ${instanceInfo.performanceMetrics.averageResponseTime.toFixed(0)}ms`,
        },
      ],
    };
  }

  private formatUptime(uptimeMs: number): string {
    const seconds = Math.floor(uptimeMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d ${hours % 24}h ${minutes % 60}m`;
    } else if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  // Method to set the VSCode context for local tool execution
  setContext(context: any): void {
    this.context = context;
    this.localExecutor = new LocalToolExecutor(this.logger, context);
  }

  // State preservation and migration methods
  async preserveState(): Promise<void> {
    try {
      const stateSnapshot = this.createStateSnapshot();
      this.logger.info('Master state preserved', {
        workers: stateSnapshot.workers.length,
        sessions: stateSnapshot.sessions.length,
      });
    } catch (error) {
      this.logger.error('Failed to preserve master state', error);
    }
  }

  private createStateSnapshot(): any {
    return {
      instanceId: this.instanceId,
      timestamp: Date.now(),
      workers: Array.from(this.state.registeredWorkers.values()),
      sessions: Array.from(this.state.activeSessions.values()),
      workspaceRouting: Array.from(this.state.workspaceRouting.entries()),
      performanceMetrics: this.state.performanceMetrics,
      startedAt: this.state.startedAt,
    };
  }

  async reconstructState(): Promise<void> {
    try {
      this.logger.info('Attempting to reconstruct master state');

      // Query all workers for their current state to rebuild routing
      const workers = Array.from(this.state.registeredWorkers.values());
      if (workers.length > 0) {
        await this.rebuildWorkspaceRouting(workers);
      }

      this.logger.info('Master state reconstruction completed');
    } catch (error) {
      this.logger.error('Failed to reconstruct master state', error);
    }
  }

  private async rebuildWorkspaceRouting(workers: WorkerInfo[]): Promise<void> {
    this.logger.info('Rebuilding workspace routing table', {
      workerCount: workers.length,
    });

    // Clear existing routing
    this.state.workspaceRouting.clear();

    // Rebuild routing from worker information
    for (const worker of workers) {
      this.updateWorkspaceRouting(worker);
    }

    this.logger.info('Workspace routing rebuilt', {
      routeCount: this.state.workspaceRouting.size,
    });
  }

  // Split-brain prevention
  async validateMasterRole(): Promise<boolean> {
    try {
      // Check if another master is running on the expected port
      const otherMasterCheck = await this.checkForOtherMaster();
      if (otherMasterCheck.exists) {
        this.logger.error('Split-brain detected: Another master is running', {
          otherMaster: otherMasterCheck.instanceId,
          ownInstanceId: this.instanceId,
        });

        // Resolve split-brain by comparing instance IDs (deterministic)
        const shouldStepDown = this.instanceId > otherMasterCheck.instanceId!;
        if (shouldStepDown) {
          this.logger.warn('Stepping down to resolve split-brain');
          await this.stepDownAsMaster();
          return false;
        } else {
          this.logger.info('Other master will step down (lower instance ID)');
        }
      }

      return true;
    } catch (error) {
      this.logger.warn('Could not validate master role', error);
      return true; // Assume we're valid if we can't check
    }
  }

  private async checkForOtherMaster(): Promise<{
    exists: boolean;
    instanceId?: string;
  }> {
    // This would be called from a different port to check the master port
    // For now, return false (no other master)
    return { exists: false };
  }

  private async stepDownAsMaster(): Promise<void> {
    this.logger.info('Stepping down as master due to split-brain resolution');

    // Preserve state before stepping down
    await this.preserveState();

    // Stop master operations
    await this.stop();

    // Attempt to transition to worker mode
    await this.transitionToWorkerMode();
  }

  private async transitionToWorkerMode(): Promise<void> {
    this.logger.info('Transitioning from master to worker mode');

    try {
      // Change our mode to worker
      this.mode = InstanceMode.WORKER;

      // Create a new WorkerCoordinator instance
      const { WorkerCoordinator } = await import('./worker');
      const workerCoordinator = new WorkerCoordinator(this.logger, this.config);

      // Set context if we have it
      if (this.context) {
        workerCoordinator.setContext(this.context);
      }

      // Small delay to allow other master to fully start
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Start as worker and try to register with the new master
      await workerCoordinator.start();

      this.logger.info('Successfully transitioned from master to worker', {
        newMode: InstanceMode.WORKER,
        workerInstanceId: workerCoordinator.getInstanceId(),
      });

      // Emit transition event
      this.emitEvent({
        type: 'mode_changed',
        instanceId: this.instanceId,
        timestamp: Date.now(),
        data: {
          newMode: InstanceMode.WORKER,
          reason: 'split_brain_resolution',
          newWorkerInstanceId: workerCoordinator.getInstanceId(),
        },
      });
    } catch (error) {
      this.logger.error(
        'Failed to transition to worker mode, falling back to standalone',
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );

      // Fallback to standalone mode if worker transition fails
      await this.fallbackToStandaloneAfterStepDown();
    }
  }

  private async fallbackToStandaloneAfterStepDown(): Promise<void> {
    this.logger.info(
      'Falling back to standalone mode after failed master step-down',
    );

    try {
      // Switch to standalone mode
      this.mode = InstanceMode.STANDALONE;

      this.emitEvent({
        type: 'mode_changed',
        instanceId: this.instanceId,
        timestamp: Date.now(),
        data: {
          newMode: InstanceMode.STANDALONE,
          reason: 'step_down_fallback',
        },
      });

      this.logger.info(
        'Successfully switched to standalone mode after step-down',
      );
    } catch (error) {
      this.logger.error('Failed to fallback to standalone mode', {
        error: error instanceof Error ? error.message : String(error),
      });

      // At this point, we're in an inconsistent state
      // Log the situation and continue operating as best we can
      this.logger.warn(
        'System in inconsistent state after failed step-down transition',
      );
    }
  }

  private updateWorkspaceRouting(worker: WorkerInfo): void {
    this.state.workspaceRouting.set(worker.workspacePath, worker.instanceId);
  }

  private cleanupWorkspaceRouting(instanceId: string): void {
    for (const [path, workerId] of this.state.workspaceRouting.entries()) {
      if (workerId === instanceId) {
        this.state.workspaceRouting.delete(path);
      }
    }
  }

  private updatePerformanceMetrics(toolCall: ToolCallLog): void {
    const metrics = this.state.performanceMetrics;
    const totalCalls = metrics.totalToolCalls + 1;
    const successCalls = toolCall.error
      ? metrics.successRate * metrics.totalToolCalls
      : metrics.successRate * metrics.totalToolCalls + 1;

    metrics.totalToolCalls = totalCalls;
    metrics.successRate = successCalls / totalCalls;
    metrics.averageResponseTime =
      (metrics.averageResponseTime * (totalCalls - 1) + toolCall.duration) /
      totalCalls;
    metrics.lastUpdated = Date.now();
  }

  private async broadcastShutdown(): Promise<void> {
    this.logger.info('Broadcasting graceful shutdown to workers', {
      workerCount: this.state.registeredWorkers.size,
    });

    if (this.state.registeredWorkers.size === 0) {
      this.logger.info('No workers to notify of shutdown');
      return;
    }

    // Notify all workers of impending shutdown
    const shutdownPromises = Array.from(
      this.state.registeredWorkers.values(),
    ).map((worker) =>
      this.notifyWorkerShutdown(worker).catch((error) => {
        this.logger.warn('Failed to notify worker of shutdown', {
          worker: worker.instanceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }),
    );

    // Wait for notifications (with timeout)
    await Promise.race([
      Promise.allSettled(shutdownPromises),
      new Promise((resolve) => setTimeout(resolve, 5000)), // 5 second timeout
    ]);

    this.logger.info('Shutdown notification completed');
  }

  private async notifyWorkerShutdown(worker: WorkerInfo): Promise<void> {
    return new Promise((resolve, reject) => {
      const shutdownMessage = {
        type: 'MASTER_SHUTDOWN',
        instanceId: this.instanceId,
        timestamp: Date.now(),
        message: 'Master is shutting down gracefully',
      };

      const postData = JSON.stringify(shutdownMessage);
      const options = {
        hostname: 'localhost',
        port: worker.port,
        path: '/coordination/shutdown',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      };

      const req = http.request(options, (res) => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });

      req.on('error', reject);
      req.setTimeout(3000, () => {
        req.destroy();
        reject(new Error('Shutdown notification timeout'));
      });

      req.write(postData);
      req.end();
    });
  }

  // Getters for status monitoring
  getRegisteredWorkers(): WorkerInfo[] {
    return Array.from(this.state.registeredWorkers.values());
  }

  getState(): MasterState {
    return { ...this.state };
  }
}
