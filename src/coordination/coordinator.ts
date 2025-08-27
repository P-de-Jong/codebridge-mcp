import * as vscode from 'vscode';
import * as http from 'http';
import {
  InstanceMode,
  CoordinationConfig,
  FailoverConfig,
  DEFAULT_COORDINATION_CONFIG,
  DEFAULT_FAILOVER_CONFIG,
  HealthCheckResponse,
  MasterStatus,
  CoordinationEvent,
  CoordinationEventCallback,
  createInstanceId,
} from './types';
import { ExtensionLogger } from '../logger';

export abstract class McpCoordinator {
  protected instanceId: string;
  protected mode: InstanceMode;
  protected config: CoordinationConfig;
  protected failoverConfig: FailoverConfig;
  protected logger: ExtensionLogger;
  protected eventCallbacks: CoordinationEventCallback[] = [];

  constructor(logger: ExtensionLogger, config?: Partial<CoordinationConfig>) {
    this.instanceId = createInstanceId();
    this.mode = InstanceMode.STANDALONE; // Default, will be detected
    this.config = { ...DEFAULT_COORDINATION_CONFIG, ...config };
    this.failoverConfig = DEFAULT_FAILOVER_CONFIG;
    this.logger = logger;
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract handleToolCall(tool: string, params: any): Promise<any>;

  getInstanceId(): string {
    return this.instanceId;
  }

  getMode(): InstanceMode {
    return this.mode;
  }

  addEventListener(callback: CoordinationEventCallback): void {
    this.eventCallbacks.push(callback);
  }

  removeEventListener(callback: CoordinationEventCallback): void {
    const index = this.eventCallbacks.indexOf(callback);
    if (index > -1) {
      this.eventCallbacks.splice(index, 1);
    }
  }

  protected emitEvent(event: CoordinationEvent): void {
    this.eventCallbacks.forEach((callback) => {
      try {
        callback(event);
      } catch (error) {
        this.logger.error('Error in coordination event callback', error);
      }
    });
  }

  protected loadConfiguration(): void {
    const vsConfig = vscode.workspace.getConfiguration('codebridge-mcp');

    // Load coordination config
    const coordinationConfig = vsConfig.get('coordination', {});
    this.config = {
      ...DEFAULT_COORDINATION_CONFIG,
      ...coordinationConfig,
    };

    // Load failover config
    const failoverConfig = vsConfig.get('failover', {});
    this.failoverConfig = {
      ...DEFAULT_FAILOVER_CONFIG,
      ...failoverConfig,
    };

    this.logger.info('Loaded coordination configuration', {
      coordination: this.config,
      failover: this.failoverConfig,
    });
  }

  protected getCurrentWorkspaceInfo() {
    // Determine workspace name and path - prefer workspace file over first folder
    const workspaceFile = vscode.workspace.workspaceFile;
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const firstFolder = workspaceFolders?.[0];

    if (workspaceFile && workspaceFolders) {
      // Multi-folder workspace with .code-workspace file
      const workspaceName =
        workspaceFile.path.split('/').pop()?.replace('.code-workspace', '') ||
        'Unknown Workspace';

      // Include all folders in the workspace
      const folders = workspaceFolders.map((folder) => ({
        name: folder.name,
        path: folder.uri.fsPath,
      }));

      return {
        name: workspaceName,
        path: workspaceFile.path,
        type: 'multi-folder' as const,
        folders: folders,
      };
    } else if (firstFolder) {
      // Single folder workspace
      return {
        name: firstFolder.name,
        path: firstFolder.uri.fsPath,
        type: 'single-folder' as const,
        folders: [
          {
            name: firstFolder.name,
            path: firstFolder.uri.fsPath,
          },
        ],
      };
    } else {
      // No workspace open
      return {
        name: 'No Workspace',
        path: process.cwd(),
        type: 'none' as const,
        folders: [],
      };
    }
  }
}

export class CoordinationDetector {
  private config: CoordinationConfig;
  private logger: ExtensionLogger;

  constructor(logger: ExtensionLogger, config: CoordinationConfig) {
    this.logger = logger;
    this.config = config;
  }

  async detectMode(): Promise<InstanceMode> {
    // If mode is forced in configuration and not AUTO, use that
    if (this.config.mode && this.config.mode !== InstanceMode.AUTO) {
      this.logger.info(`Coordination mode forced to: ${this.config.mode}`);
      return this.config.mode;
    }

    // If coordination is disabled, run standalone
    if (!this.config.enabled) {
      this.logger.info('Coordination disabled, running in standalone mode');
      return InstanceMode.STANDALONE;
    }

    this.logger.info('Auto-detecting coordination mode...');

    // Try to detect existing master
    const masterStatus = await this.checkMasterHealth();

    if (masterStatus === MasterStatus.HEALTHY) {
      this.logger.info(
        `Found healthy master at port ${this.config.masterPort}, becoming worker`,
      );
      return InstanceMode.WORKER;
    }

    if (masterStatus === MasterStatus.UNREACHABLE) {
      this.logger.info(
        `No master found at port ${this.config.masterPort}, becoming master`,
      );
      return InstanceMode.MASTER;
    }

    // Master is degraded, decide based on additional factors
    this.logger.warn(
      `Master at port ${this.config.masterPort} is degraded, evaluating options`,
    );

    // Check if we should initiate election or try to connect to degraded master
    const shouldInitiateElection =
      await this.shouldInitiateElectionForDegradedMaster();

    if (shouldInitiateElection) {
      this.logger.info('Initiating election due to degraded master');
      return InstanceMode.MASTER; // Will start election process
    } else {
      this.logger.info('Attempting to connect to degraded master as worker');
      return InstanceMode.WORKER;
    }
  }

  async checkMasterHealth(): Promise<MasterStatus> {
    return new Promise<MasterStatus>((resolve) => {
      const timeout = setTimeout(() => {
        resolve(MasterStatus.UNREACHABLE);
      }, this.config.registrationTimeout);

      const healthUrl = `http://localhost:${this.config.masterPort}/coordination/health`;

      const req = http.get(healthUrl, (res) => {
        clearTimeout(timeout);

        if (res.statusCode === 200) {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              JSON.parse(data) as HealthCheckResponse;

              // Determine health based on response time and content
              const responseTime = Date.now() - startTime;
              if (responseTime > 2000) {
                resolve(MasterStatus.DEGRADED);
              } else {
                resolve(MasterStatus.HEALTHY);
              }
            } catch (error) {
              this.logger.warn('Invalid health response from master', error);
              resolve(MasterStatus.DEGRADED);
            }
          });
        } else {
          resolve(MasterStatus.DEGRADED);
        }
      });

      const startTime = Date.now();

      req.on('error', (error) => {
        clearTimeout(timeout);
        this.logger.debug('Master health check failed', error);
        resolve(MasterStatus.UNREACHABLE);
      });

      req.setTimeout(this.config.registrationTimeout, () => {
        clearTimeout(timeout);
        req.destroy();
        resolve(MasterStatus.UNREACHABLE);
      });
    });
  }

  async findAvailablePort(startPort: number, endPort: number): Promise<number> {
    for (let port = startPort; port <= endPort; port++) {
      if (await this.isPortAvailable(port)) {
        return port;
      }
    }
    throw new Error(`No available ports in range ${startPort}-${endPort}`);
  }

  private isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = http.createServer();

      server.listen(port, 'localhost', () => {
        server.close(() => resolve(true));
      });

      server.on('error', () => resolve(false));
    });
  }

  private async shouldInitiateElectionForDegradedMaster(): Promise<boolean> {
    // Check multiple factors to decide if we should initiate election
    // for a degraded master instead of trying to connect as worker

    // Factor 1: Check master response time and stability over multiple attempts
    let failureCount = 0;
    const maxChecks = 3;

    for (let i = 0; i < maxChecks; i++) {
      const status = await this.checkMasterHealth();
      if (
        status === MasterStatus.DEGRADED ||
        status === MasterStatus.UNREACHABLE
      ) {
        failureCount++;
      }

      // Small delay between checks
      if (i < maxChecks - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    // If master consistently fails/degrades, initiate election
    const consistentFailure = failureCount >= Math.ceil(maxChecks * 0.67); // 67% failure rate

    if (consistentFailure) {
      this.logger.info(
        'Master consistently degraded/failed, should initiate election',
        {
          failureCount,
          maxChecks,
          failureRate: ((failureCount / maxChecks) * 100).toFixed(1) + '%',
        },
      );
      return true;
    }

    // Factor 2: Check if we're likely to be a good master candidate
    const ourWorkspaceScore = this.calculateLocalWorkspaceScore();
    const threshold = 50; // Minimum score to consider being master

    if (ourWorkspaceScore < threshold) {
      this.logger.debug('Low workspace score, prefer connecting as worker', {
        workspaceScore: ourWorkspaceScore,
        threshold,
      });
      return false;
    }

    // Factor 3: Random backoff to prevent all instances from trying to become master
    const randomDelay = Math.random() * 2000; // 0-2 seconds
    await new Promise((resolve) => setTimeout(resolve, randomDelay));

    // Re-check master status after random delay
    const finalStatus = await this.checkMasterHealth();
    const shouldElect =
      finalStatus === MasterStatus.DEGRADED ||
      finalStatus === MasterStatus.UNREACHABLE;

    this.logger.info('Election decision made', {
      finalMasterStatus: finalStatus,
      ourWorkspaceScore,
      randomDelay: randomDelay.toFixed(0) + 'ms',
      willInitiateElection: shouldElect,
    });

    return shouldElect;
  }

  private calculateLocalWorkspaceScore(): number {
    // Simple scoring based on current environment
    let score = 0;

    // Check if we have an active workspace
    const workspaceInfo = this.getCurrentWorkspaceInfo();
    if (workspaceInfo.type !== 'none') {
      score += 30; // Base score for having a workspace
    }

    // Check number of folders (multi-folder workspaces get higher scores)
    if (workspaceInfo.folders) {
      score += Math.min(workspaceInfo.folders.length * 10, 30); // Max 30 points for folders
    }

    // Check if workspace has git (simplified check)
    if (workspaceInfo.path !== process.cwd()) {
      score += 20; // Likely a project workspace vs just current directory
    }

    // Add some randomness to break ties
    score += Math.random() * 10;

    return score;
  }

  private getCurrentWorkspaceInfo() {
    // This mirrors the method from McpCoordinator but we need it here
    const workspaceFolders = require('vscode').workspace?.workspaceFolders;
    const workspaceFile = require('vscode').workspace?.workspaceFile;
    const firstFolder = workspaceFolders?.[0];

    if (workspaceFile && workspaceFolders) {
      const workspaceName =
        workspaceFile.path.split('/').pop()?.replace('.code-workspace', '') ||
        'Unknown Workspace';
      const folders = workspaceFolders.map((folder: any) => ({
        name: folder.name,
        path: folder.uri.fsPath,
      }));

      return {
        name: workspaceName,
        path: workspaceFile.path,
        type: 'multi-folder' as const,
        folders: folders,
      };
    } else if (firstFolder) {
      return {
        name: firstFolder.name,
        path: firstFolder.uri.fsPath,
        type: 'single-folder' as const,
        folders: [
          {
            name: firstFolder.name,
            path: firstFolder.uri.fsPath,
          },
        ],
      };
    } else {
      return {
        name: 'No Workspace',
        path: process.cwd(),
        type: 'none' as const,
        folders: [],
      };
    }
  }
}

export async function createCoordinator(
  logger: ExtensionLogger,
): Promise<McpCoordinator> {
  const detector = new CoordinationDetector(
    logger,
    DEFAULT_COORDINATION_CONFIG,
  );

  // Load configuration from VSCode settings
  const vsConfig = vscode.workspace.getConfiguration('codebridge-mcp');
  const config = {
    ...DEFAULT_COORDINATION_CONFIG,
    ...vsConfig.get('coordination', {}),
  };

  detector['config'] = config; // Update detector config

  const mode = await detector.detectMode();

  logger.info(`Creating coordinator in ${mode} mode`);

  // Create the appropriate coordinator based on detected mode
  switch (mode) {
    case InstanceMode.MASTER: {
      const { MasterCoordinator } = await import('./master');
      return new MasterCoordinator(logger, config);
    }
    case InstanceMode.WORKER: {
      const { WorkerCoordinator } = await import('./worker');
      return new WorkerCoordinator(logger, config);
    }
    case InstanceMode.AUTO:
      // AUTO should have been resolved by detectMode(), this shouldn't happen
      logger.warn('AUTO mode not resolved, falling back to standalone');
      return new StandaloneCoordinator(logger, config);
    case InstanceMode.STANDALONE:
    default:
      return new StandaloneCoordinator(logger, config);
  }
}

// Temporary standalone coordinator for Phase 1 backward compatibility
class StandaloneCoordinator extends McpCoordinator {
  constructor(logger: ExtensionLogger, config: CoordinationConfig) {
    super(logger, config);
    this.mode = InstanceMode.STANDALONE;
  }

  async start(): Promise<void> {
    this.logger.info('Starting standalone coordinator (Phase 1)');
    // This will delegate to existing MCP server logic
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping standalone coordinator');
  }

  async handleToolCall(_tool: string, _params: any): Promise<any> {
    // This will delegate to existing tool implementations
    throw new Error('Tool handling not implemented in Phase 1');
  }
}
