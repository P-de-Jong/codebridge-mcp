import * as http from 'http';
import * as vscode from 'vscode';
import express from 'express';
import { McpCoordinator, CoordinationDetector } from './coordinator';
import {
  WorkerInfo,
  InstanceMode,
  CoordinationConfig,
  RegistrationRequest,
  RegistrationResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  MasterStatus,
  ElectionCandidate,
  ElectionMessage,
  createWorkerInfo,
} from './types';
import { ExtensionLogger } from '../logger';
import { LocalToolExecutor, ToolExecutor } from './toolExecutor';
import { LeaderElection } from './election';

export class WorkerCoordinator extends McpCoordinator {
  private workerInfo: WorkerInfo | null = null;
  private localServer: express.Application | null = null;
  private localHttpServer: http.Server | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private masterHealthTimer: NodeJS.Timeout | null = null;
  private detector: CoordinationDetector;
  private registrationRetries: number = 0;
  private maxRegistrationRetries: number = 5;
  private localExecutor: ToolExecutor | null = null;
  private context: any = null;
  private election: LeaderElection;
  private masterFailureCount: number = 0;
  private maxMasterFailures: number = 3;
  private becomingMaster: boolean = false;

  constructor(logger: ExtensionLogger, config: CoordinationConfig) {
    super(logger, config);
    this.mode = InstanceMode.WORKER;
    this.detector = new CoordinationDetector(logger, config);
    this.election = new LeaderElection(
      logger,
      config,
      this.failoverConfig,
      this.instanceId,
    );
  }

  async start(): Promise<void> {
    this.logger.info('Starting Worker Coordinator', {
      instanceId: this.instanceId,
    });

    // Find available port for local server
    const localPort = await this.detector.findAvailablePort(
      this.config.workerPortRange[0],
      this.config.workerPortRange[1],
    );

    // Create worker info
    const workspace = this.getCurrentWorkspaceInfo();
    this.workerInfo = createWorkerInfo(
      workspace.name,
      workspace.path,
      localPort,
      this.getAvailableCapabilities(),
    );

    // Start local server for handling tool calls
    await this.startLocalServer();

    // Register with master
    await this.registerWithMaster();

    // Start heartbeat and health monitoring
    this.startHeartbeat();
    this.startMasterHealthCheck();

    this.emitEvent({
      type: 'worker_registered',
      instanceId: this.instanceId,
      timestamp: Date.now(),
      data: this.workerInfo,
    });
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping Worker Coordinator');

    // Stop timers
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.masterHealthTimer) {
      clearInterval(this.masterHealthTimer);
      this.masterHealthTimer = null;
    }

    // Deregister from master
    await this.deregisterFromMaster();

    // Stop local server
    if (this.localHttpServer) {
      this.localHttpServer.close();
      this.localHttpServer = null;
    }

    this.localServer = null;
    this.workerInfo = null;
  }

  async handleToolCall(tool: string, params: any): Promise<any> {
    // For worker mode, this shouldn't be called directly
    // Tool calls should be routed through the master
    this.logger.warn('Direct tool call to worker coordinator', { tool });
    return await this.executeLocalTool(tool, params);
  }

  private async startLocalServer(): Promise<void> {
    if (!this.workerInfo) {
      throw new Error('Worker info not initialized');
    }

    this.localServer = express();
    this.localServer.use(express.json());

    this.setupLocalServerRoutes();

    return new Promise((resolve, reject) => {
      this.localHttpServer = this.localServer!.listen(
        this.workerInfo!.port,
        'localhost',
        () => {
          this.logger.info(
            `Worker local server listening on port ${this.workerInfo!.port}`,
          );
          resolve();
        },
      );

      this.localHttpServer!.on('error', (error) => {
        this.logger.error('Failed to start worker local server', error);
        reject(error);
      });
    });
  }

  private setupLocalServerRoutes(): void {
    const app = this.localServer!;

    // Health check endpoint
    app.get('/health', (_req, res) => {
      res.json({
        status: 'healthy',
        instanceId: this.instanceId,
        workspaceName: this.workerInfo?.workspaceName,
        capabilities: this.workerInfo?.capabilities || [],
      });
    });

    // Tool execution endpoint
    app.post('/tools/:toolName', async (req, res) => {
      try {
        const toolName = req.params.toolName;
        const params = req.body;

        this.logger.debug('Executing tool locally', { tool: toolName });
        const result = await this.executeLocalTool(toolName, params);
        res.json({ success: true, result });
      } catch (error) {
        this.logger.error('Local tool execution failed', error);
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    // Context endpoint - return current workspace context
    app.get('/context', (_req, res) => {
      res.json({
        workspace: this.getCurrentWorkspaceInfo(),
        activeEditor: this.getActiveEditorInfo(),
        openFiles: this.getOpenFilesInfo(),
      });
    });

    // Election endpoints
    app.get('/election/candidate', (_req, res) => {
      try {
        const candidateInfo = this.createCandidateInfo();
        res.json(candidateInfo);
      } catch (error) {
        this.logger.error('Failed to create candidate info', error);
        res.status(500).json({ error: 'Failed to create candidate info' });
      }
    });

    app.post('/election/message', (req, res) => {
      try {
        const message = req.body;
        this.handleElectionMessage(message);
        res.json({ success: true });
      } catch (error) {
        this.logger.error('Failed to handle election message', error);
        res.status(500).json({ error: 'Failed to handle election message' });
      }
    });

    // Graceful shutdown notification endpoint
    app.post('/coordination/shutdown', (req, res) => {
      try {
        const message = req.body;
        this.handleMasterShutdown(message);
        res.json({ success: true });
      } catch (error) {
        this.logger.error('Failed to handle master shutdown', error);
        res
          .status(500)
          .json({ error: 'Failed to handle shutdown notification' });
      }
    });
  }

  private async registerWithMaster(): Promise<void> {
    if (!this.workerInfo) {
      throw new Error('Worker info not initialized');
    }

    const registrationRequest: RegistrationRequest = {
      instanceId: this.workerInfo.instanceId,
      workspaceName: this.workerInfo.workspaceName,
      workspacePath: this.workerInfo.workspacePath,
      port: this.workerInfo.port,
      capabilities: this.workerInfo.capabilities,
      version: this.workerInfo.version,
    };

    try {
      const response = await this.makeHttpRequest<RegistrationResponse>(
        'POST',
        `/coordination/workers/register`,
        registrationRequest,
      );

      if (response.success) {
        this.logger.info('Successfully registered with master', {
          masterInstanceId: response.masterInstanceId,
          heartbeatInterval: response.heartbeatInterval,
        });
        this.registrationRetries = 0;

        // Update config with master's heartbeat interval
        this.config.heartbeatInterval = response.heartbeatInterval;
      } else {
        throw new Error(response.error || 'Registration failed');
      }
    } catch (error) {
      this.logger.error('Failed to register with master', error);

      if (this.registrationRetries < this.maxRegistrationRetries) {
        this.registrationRetries++;
        const delay = Math.pow(2, this.registrationRetries) * 1000; // Exponential backoff
        this.logger.info(
          `Retrying registration in ${delay}ms (attempt ${this.registrationRetries}/${this.maxRegistrationRetries})`,
        );

        setTimeout(() => {
          this.registerWithMaster().catch((err) => {
            this.logger.error('Registration retry failed', err);
          });
        }, delay);
      } else {
        this.logger.error(
          'Max registration retries exceeded, falling back to standalone mode',
        );
        await this.fallbackToStandaloneMode();
      }
    }
  }

  private async deregisterFromMaster(): Promise<void> {
    if (!this.workerInfo) {
      return;
    }

    try {
      await this.makeHttpRequest(
        'DELETE',
        `/coordination/workers/${this.workerInfo.instanceId}`,
        {},
      );
      this.logger.info('Successfully deregistered from master');
    } catch (error) {
      this.logger.warn('Failed to deregister from master', error);
      // Not critical, master will eventually timeout the worker
    }
  }

  private startHeartbeat(): void {
    if (!this.workerInfo) {
      return;
    }

    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.sendHeartbeat();
      } catch (error) {
        this.logger.warn('Heartbeat failed', error);
        // Will be handled by master health check
      }
    }, this.config.heartbeatInterval);
  }

  private async sendHeartbeat(): Promise<void> {
    if (!this.workerInfo) {
      return;
    }

    const heartbeatRequest: HeartbeatRequest = {
      instanceId: this.workerInfo.instanceId,
      status: this.determineWorkerStatus(),
      timestamp: Date.now(),
    };

    const response = await this.makeHttpRequest<HeartbeatResponse>(
      'POST',
      `/coordination/workers/${this.workerInfo.instanceId}/heartbeat`,
      heartbeatRequest,
    );

    if (response.shouldReregister) {
      this.logger.warn('Master requested re-registration');
      await this.registerWithMaster();
    }
  }

  private startMasterHealthCheck(): void {
    this.masterHealthTimer = setInterval(async () => {
      try {
        const status = await this.detector.checkMasterHealth();

        if (status === MasterStatus.HEALTHY) {
          // Reset failure count on successful health check
          this.masterFailureCount = 0;
        } else if (
          status === MasterStatus.UNREACHABLE ||
          status === MasterStatus.DEGRADED
        ) {
          this.logger.warn('Master health check failed', {
            status,
            failureCount: this.masterFailureCount + 1,
          });
          await this.handleMasterFailure();
        }
      } catch (error) {
        this.logger.warn('Master health check error', error);
        await this.handleMasterFailure();
      }
    }, this.failoverConfig.masterHealthCheckInterval);
  }

  private async handleMasterFailure(): Promise<void> {
    this.masterFailureCount++;
    this.logger.warn('Master failure detected', {
      failureCount: this.masterFailureCount,
      maxFailures: this.maxMasterFailures,
    });

    if (
      this.masterFailureCount >= this.maxMasterFailures &&
      !this.becomingMaster
    ) {
      this.logger.info('Master confirmed failed, initiating election');

      this.emitEvent({
        type: 'failover_initiated',
        instanceId: this.instanceId,
        timestamp: Date.now(),
      });

      await this.initiateElection();
    }
  }

  private async initiateElection(): Promise<void> {
    if (this.becomingMaster || this.election.isElectionInProgress()) {
      this.logger.debug('Election already in progress, skipping');
      return;
    }

    try {
      // Get all known workers (we might not have the complete list, but that's ok)
      const knownWorkers = await this.discoverOtherWorkers();

      this.logger.info('Starting election process', {
        candidateCount: knownWorkers.length + 1, // +1 for self
      });

      const winnerId = await this.election.startElection(knownWorkers);

      if (winnerId === this.instanceId) {
        await this.becomeMaster();
      } else {
        this.logger.info('Another worker won election', { winner: winnerId });
        // The winner will start their master server, we'll detect and re-register
        await this.waitForNewMaster(winnerId);
      }
    } catch (error) {
      this.logger.error('Election failed', error);
      // Fallback: try to become master ourselves if no one else can
      if (!this.becomingMaster) {
        this.logger.warn(
          'Election failed, attempting to become master as fallback',
        );
        await this.becomeMaster();
      }
    }
  }

  private async discoverOtherWorkers(): Promise<WorkerInfo[]> {
    this.logger.info('Discovering other workers for election');

    const discoveredWorkers: WorkerInfo[] = [];

    // Strategy 1: Try to get worker list from the master (if still responsive)
    try {
      const workersFromMaster = await this.getWorkersFromMaster();
      if (workersFromMaster && workersFromMaster.length > 0) {
        discoveredWorkers.push(...workersFromMaster);
        this.logger.info('Discovered workers from master', {
          count: workersFromMaster.length,
        });
      }
    } catch (error) {
      this.logger.debug('Could not get workers from master', error);
    }

    // Strategy 2: Port scanning in the worker port range
    if (discoveredWorkers.length === 0) {
      const portScanWorkers = await this.discoverWorkersByPortScan();
      discoveredWorkers.push(...portScanWorkers);
      this.logger.info('Discovered workers by port scanning', {
        count: portScanWorkers.length,
      });
    }

    // Strategy 3: Use cached information if available (not implemented here)
    // Could implement persistent storage of known workers

    // Filter out ourselves
    const otherWorkers = discoveredWorkers.filter(
      (worker) => worker.instanceId !== this.instanceId,
    );

    this.logger.info('Worker discovery completed', {
      totalFound: discoveredWorkers.length,
      otherWorkers: otherWorkers.length,
      selfInstanceId: this.instanceId,
    });

    return otherWorkers;
  }

  private async getWorkersFromMaster(): Promise<WorkerInfo[]> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Master workers request timeout'));
      }, 3000);

      const url = `http://localhost:${this.config.masterPort}/coordination/workers`;
      const req = http.get(url, (res) => {
        clearTimeout(timeout);

        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            if (res.statusCode === 200) {
              const response = JSON.parse(data);
              resolve(response.workers || []);
            } else {
              reject(new Error(`HTTP ${res.statusCode}`));
            }
          } catch (error) {
            reject(new Error(`Invalid JSON response: ${data}`));
          }
        });
      });

      req.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      req.setTimeout(3000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
    });
  }

  private async discoverWorkersByPortScan(): Promise<WorkerInfo[]> {
    const discoveredWorkers: WorkerInfo[] = [];
    const [startPort, endPort] = this.config.workerPortRange;

    this.logger.debug('Starting port scan for worker discovery', {
      portRange: `${startPort}-${endPort}`,
    });

    // Limit concurrent scans to avoid overwhelming the system
    const maxConcurrent = 10;

    for (let port = startPort; port <= endPort; port += maxConcurrent) {
      const batch: Promise<WorkerInfo | null>[] = [];

      for (let i = 0; i < maxConcurrent && port + i <= endPort; i++) {
        const currentPort = port + i;
        batch.push(this.checkWorkerAtPort(currentPort));
      }

      const batchResults = await Promise.allSettled(batch);
      const validWorkers = batchResults
        .map((result) => (result.status === 'fulfilled' ? result.value : null))
        .filter((worker): worker is WorkerInfo => worker !== null);

      discoveredWorkers.push(...validWorkers);

      // Small delay between batches to be respectful
      if (port + maxConcurrent <= endPort) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    this.logger.debug('Port scan completed', {
      portsScanned: endPort - startPort + 1,
      workersFound: discoveredWorkers.length,
    });

    return discoveredWorkers;
  }

  private async checkWorkerAtPort(port: number): Promise<WorkerInfo | null> {
    // Skip our own port
    if (this.workerInfo && port === this.workerInfo.port) {
      return null;
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(null);
      }, 2000); // 2 second timeout per port

      const url = `http://localhost:${port}/health`;
      const req = http.get(url, (res) => {
        clearTimeout(timeout);

        if (res.statusCode === 200) {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              const healthInfo = JSON.parse(data);

              // Check if this looks like a worker response
              if (
                healthInfo.instanceId &&
                healthInfo.workspaceName !== undefined
              ) {
                // Create WorkerInfo from health response
                const workerInfo: WorkerInfo = {
                  instanceId: healthInfo.instanceId,
                  workspaceName: healthInfo.workspaceName || 'Unknown',
                  workspacePath: '', // Not available from health check
                  port: port,
                  capabilities: healthInfo.capabilities || [],
                  lastSeen: Date.now(),
                  status: healthInfo.status === 'healthy' ? 'active' : 'idle',
                  registeredAt: Date.now(),
                  version: healthInfo.version || '0.1.0',
                };

                resolve(workerInfo);
              } else {
                resolve(null);
              }
            } catch (error) {
              resolve(null);
            }
          });
        } else {
          resolve(null);
        }
      });

      req.on('error', () => {
        clearTimeout(timeout);
        resolve(null);
      });

      req.setTimeout(2000, () => {
        req.destroy();
        resolve(null);
      });
    });
  }

  private async becomeMaster(): Promise<void> {
    if (this.becomingMaster) {
      return;
    }

    this.becomingMaster = true;
    this.logger.info('Becoming new master');

    try {
      // Stop worker operations
      await this.stop();

      // Switch to master mode and start master server
      // This would typically involve importing and creating MasterCoordinator
      this.logger.info(
        'Transitioning from worker to master - would start master server here',
      );

      // Reset failure count
      this.masterFailureCount = 0;

      this.emitEvent({
        type: 'master_changed',
        instanceId: this.instanceId,
        timestamp: Date.now(),
        data: { newMasterPort: this.config.masterPort },
      });
    } catch (error) {
      this.logger.error('Failed to become master', error);
      this.becomingMaster = false;
      throw error;
    }
  }

  private async waitForNewMaster(winnerId: string): Promise<void> {
    this.logger.info('Waiting for new master to start', {
      expectedMaster: winnerId,
    });

    // Wait for the new master to start up
    const maxWaitTime = 30000; // 30 seconds
    const checkInterval = 2000; // 2 seconds
    let elapsed = 0;

    while (elapsed < maxWaitTime) {
      const masterStatus = await this.detector.checkMasterHealth();
      if (masterStatus === MasterStatus.HEALTHY) {
        this.logger.info('New master detected, re-registering');
        this.masterFailureCount = 0; // Reset failure count
        await this.registerWithMaster();
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, checkInterval));
      elapsed += checkInterval;
    }

    this.logger.warn(
      'New master did not start in time, will attempt to become master',
    );
    await this.becomeMaster();
  }

  private createCandidateInfo(): ElectionCandidate {
    if (!this.workerInfo) {
      throw new Error('Worker not initialized');
    }

    const workspace = this.getCurrentWorkspaceInfo();
    const workspaceScore = this.calculateWorkspaceScore(workspace);
    const uptime = Date.now() - this.workerInfo.registeredAt;
    const resourceUsage = this.estimateResourceUsage();

    return {
      instanceId: this.instanceId,
      workspaceScore,
      uptime,
      resourceUsage,
      capabilities: this.workerInfo.capabilities,
      lastSeen: Date.now(),
      workerInfo: this.workerInfo,
    };
  }

  private calculateWorkspaceScore(_workspace: any): number {
    // Simple workspace scoring - in real implementation would be more sophisticated
    const fileCount = 50; // Would count actual files
    const gitCommits = 10; // Would check git history
    const recentActivity = this.workerInfo?.status === 'active' ? 100 : 10;

    return fileCount * 0.4 + gitCommits * 0.3 + recentActivity * 0.3;
  }

  private estimateResourceUsage(): number {
    // Simple resource usage estimation (0-100)
    // In real implementation would check actual CPU/memory usage
    return 20 + Math.random() * 30; // Random between 20-50
  }

  private handleElectionMessage(message: ElectionMessage): void {
    this.logger.info('Received election message', {
      type: message.type,
      from: message.fromInstanceId,
    });

    switch (message.type) {
      case 'MASTER_ELECTED':
        const newMasterId = message.data?.newMasterId;
        if (newMasterId && newMasterId !== this.instanceId) {
          this.logger.info('New master elected', { master: newMasterId });
          this.waitForNewMaster(newMasterId);
        }
        break;

      case 'ELECTION_START':
        this.logger.info('Election started by another worker');
        // Could participate in the election if not already doing so
        break;

      case 'ELECTION_ABORT':
        this.logger.info('Election aborted');
        this.election.abortElection();
        break;
    }
  }

  private handleMasterShutdown(message: any): void {
    this.logger.info('Master shutdown notification received', {
      masterInstanceId: message.instanceId,
      timestamp: message.timestamp,
    });

    // Master is shutting down gracefully, prepare for election
    this.masterFailureCount = this.maxMasterFailures; // Mark as failed immediately

    // Initiate election after a short delay to allow master to fully shut down
    setTimeout(() => {
      this.handleMasterFailure().catch((error) => {
        this.logger.error('Failed to handle graceful master shutdown', error);
      });
    }, 2000); // 2 second delay
  }

  private async makeHttpRequest<T = any>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    data?: any,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = `http://localhost:${this.config.masterPort}${path}`;
      const options = {
        method,
        headers: {
          'Content-Type': 'application/json',
        },
      };

      const req = http.request(url, options, (res) => {
        let responseData = '';

        res.on('data', (chunk) => {
          responseData += chunk;
        });

        res.on('end', () => {
          try {
            const parsed = JSON.parse(responseData);
            if (
              res.statusCode &&
              res.statusCode >= 200 &&
              res.statusCode < 300
            ) {
              resolve(parsed);
            } else {
              reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
            }
          } catch (error) {
            reject(new Error(`Invalid JSON response: ${responseData}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.setTimeout(this.config.registrationTimeout, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (data && method === 'POST') {
        req.write(JSON.stringify(data));
      }

      req.end();
    });
  }

  private determineWorkerStatus(): 'active' | 'idle' {
    // Check if VSCode window is focused and has recent activity
    const activeEditor = vscode.window.activeTextEditor;
    return activeEditor ? 'active' : 'idle';
  }

  private getAvailableCapabilities(): string[] {
    // Return list of tools this worker can execute
    return [
      // 'get_file_content',
      'get_diagnostics',
      'find_references',
      'find_definition',
      'get_selection',
      'get_symbols',
      'get_open_files',
      'search_files',
      'get_workspaces', // Workers can report their own workspace info
      'get_instances', // Workers can report their own instance info
    ];
  }

  private getActiveEditorInfo() {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      return null;
    }

    return {
      fileName: activeEditor.document.fileName,
      languageId: activeEditor.document.languageId,
      isDirty: activeEditor.document.isDirty,
      selection: {
        start: activeEditor.selection.start,
        end: activeEditor.selection.end,
      },
    };
  }

  private getOpenFilesInfo() {
    return vscode.workspace.textDocuments.map((doc) => ({
      fileName: doc.fileName,
      languageId: doc.languageId,
      isDirty: doc.isDirty,
    }));
  }

  private async executeLocalTool(tool: string, params: any): Promise<any> {
    // Handle worker-specific tools first
    if (tool === 'get_workspaces') {
      return await this.executeGetWorkerWorkspace();
    }

    if (tool === 'get_instances') {
      return await this.executeGetWorkerInstance();
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

  private async executeGetWorkerWorkspace(): Promise<any> {
    // Return this worker's workspace info for aggregation
    if (!this.workerInfo) {
      return {
        content: [
          {
            type: 'text',
            text: 'Worker not initialized',
          },
        ],
      };
    }

    const workerWorkspaceData = {
      instanceId: this.workerInfo.instanceId,
      name: this.workerInfo.workspaceName,
      path: this.workerInfo.workspacePath,
      type: 'worker',
      status: this.workerInfo.status,
      lastSeen: new Date(this.workerInfo.lastSeen).toISOString(),
    };

    return {
      content: [
        {
          type: 'text',
          text:
            `**${workerWorkspaceData.name}** (worker)\n` +
            `  • Path: ${workerWorkspaceData.path}\n` +
            `  • Instance: ${workerWorkspaceData.instanceId}\n` +
            `  • Status: ${workerWorkspaceData.status}\n` +
            `  • Last seen: ${workerWorkspaceData.lastSeen}`,
        },
      ],
    };
  }

  private async executeGetWorkerInstance(): Promise<any> {
    // Return this worker's instance info for aggregation
    if (!this.workerInfo) {
      return {
        content: [
          {
            type: 'text',
            text: 'Worker not initialized',
          },
        ],
      };
    }

    const uptime = Date.now() - this.workerInfo.registeredAt;
    const uptimeStr = this.formatUptime(uptime);

    const instanceInfo = {
      instanceId: this.workerInfo.instanceId,
      type: 'worker',
      status: this.workerInfo.status,
      workspaceName: this.workerInfo.workspaceName,
      workspacePath: this.workerInfo.workspacePath,
      port: this.workerInfo.port,
      uptime: uptimeStr,
      capabilities: this.workerInfo.capabilities,
      version: this.workerInfo.version,
      lastSeen: new Date(this.workerInfo.lastSeen).toISOString(),
      registeredAt: new Date(this.workerInfo.registeredAt).toISOString(),
    };

    return {
      content: [
        {
          type: 'text',
          text:
            `**${instanceInfo.instanceId}** (worker)\n` +
            `  • Status: ${instanceInfo.status}\n` +
            `  • Workspace: ${instanceInfo.workspaceName}\n` +
            `  • Path: ${instanceInfo.workspacePath}\n` +
            `  • Port: ${instanceInfo.port}\n` +
            `  • Uptime: ${instanceInfo.uptime}\n` +
            `  • Version: ${instanceInfo.version}\n` +
            `  • Capabilities: ${instanceInfo.capabilities.join(', ')}\n` +
            `  • Last seen: ${instanceInfo.lastSeen}\n` +
            `  • Registered: ${instanceInfo.registeredAt}`,
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

  // Getters for status monitoring
  getWorkerInfo(): WorkerInfo | null {
    return this.workerInfo;
  }

  isRegistered(): boolean {
    return this.workerInfo !== null;
  }

  private async fallbackToStandaloneMode(): Promise<void> {
    this.logger.info(
      'Falling back to standalone mode due to registration failure',
    );

    try {
      // Stop worker operations
      await this.stopWorkerOperations();

      // Switch mode to standalone
      this.mode = InstanceMode.STANDALONE;

      // Emit event about mode change
      this.emitEvent({
        type: 'mode_changed',
        instanceId: this.instanceId,
        timestamp: Date.now(),
        data: {
          newMode: InstanceMode.STANDALONE,
          reason: 'registration_failure',
        },
      });

      // Continue operating in standalone mode - tools will execute locally
      this.logger.info('Successfully switched to standalone mode', {
        instanceId: this.instanceId,
        originalMode: InstanceMode.WORKER,
      });
    } catch (error) {
      this.logger.error('Failed to fallback to standalone mode', error);
      // Even if fallback fails, continue operating as best we can
      this.mode = InstanceMode.STANDALONE;
    }
  }

  private async stopWorkerOperations(): Promise<void> {
    this.logger.debug('Stopping worker-specific operations');

    // Stop timers without attempting deregistration
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.masterHealthTimer) {
      clearInterval(this.masterHealthTimer);
      this.masterHealthTimer = null;
    }

    // Keep local server running but remove worker-specific routes
    // The local server can still be useful for diagnostic purposes
    if (this.localServer) {
      this.logger.debug('Keeping local server running in standalone mode');
    }

    // Clear worker state
    this.masterFailureCount = 0;
    this.registrationRetries = 0;

    this.logger.debug('Worker operations stopped');
  }
}
