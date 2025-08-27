import { randomUUID } from 'crypto';

export enum InstanceMode {
  AUTO = 'auto',
  MASTER = 'master',
  WORKER = 'worker',
  STANDALONE = 'standalone',
}

export enum MasterStatus {
  HEALTHY = 'healthy',
  DEGRADED = 'degraded',
  UNREACHABLE = 'unreachable',
  SHUTDOWN = 'shutdown',
}

export interface CoordinationConfig {
  enabled: boolean;
  masterPort: number;
  workerPortRange: [number, number];
  heartbeatInterval: number;
  registrationTimeout: number;
  mode?: InstanceMode;
}

export interface FailoverConfig {
  enabled: boolean;
  masterHealthCheckInterval: number;
  masterTimeoutThreshold: number;
  electionTimeout: number;
  backoffMultiplier: number;
  quorumSize: number;
  backupMaster: boolean;
}

export interface WorkerInfo {
  instanceId: string;
  workspaceName: string;
  workspacePath: string;
  port: number;
  capabilities: string[];
  lastSeen: number;
  status: 'active' | 'idle';
  registeredAt: number;
  version: string;
}

export interface MasterState {
  registeredWorkers: Map<string, WorkerInfo>;
  activeSessions: Map<string, SessionInfo>;
  toolCallHistory: ToolCallLog[];
  workspaceRouting: Map<string, string>;
  performanceMetrics: PerformanceData;
  startedAt: number;
  instanceId: string;
}

export interface SessionInfo {
  sessionId: string;
  clientInfo: string;
  startedAt: number;
  lastActivity: number;
  toolCallCount: number;
}

export interface ToolCallLog {
  id: string;
  tool: string;
  params: any;
  result: any;
  error?: string;
  timestamp: number;
  duration: number;
  routedTo?: string;
}

export interface PerformanceData {
  averageResponseTime: number;
  totalToolCalls: number;
  successRate: number;
  lastUpdated: number;
}

export interface ElectionCandidate {
  instanceId: string;
  workspaceScore: number;
  uptime: number;
  resourceUsage: number;
  capabilities: string[];
  lastSeen: number;
  workerInfo: WorkerInfo;
}

export interface WorkspaceInfo {
  path: string;
  name: string;
  fileCount: number;
  gitCommits: number;
  recentActivity: number;
  isOpen: boolean;
}

export interface HealthCheckResponse {
  status: MasterStatus;
  instanceId: string;
  uptime: number;
  workerCount: number;
  version: string;
  timestamp: number;
}

export interface RegistrationRequest {
  instanceId: string;
  workspaceName: string;
  workspacePath: string;
  port: number;
  capabilities: string[];
  version: string;
}

export interface RegistrationResponse {
  success: boolean;
  instanceId: string;
  masterInstanceId: string;
  heartbeatInterval: number;
  error?: string;
}

export interface HeartbeatRequest {
  instanceId: string;
  status: 'active' | 'idle';
  timestamp: number;
}

export interface HeartbeatResponse {
  success: boolean;
  masterStatus: MasterStatus;
  shouldReregister?: boolean;
}

export interface ToolRoutingStrategy {
  workspace_specific: string[];
  active_context: string[];
  aggregated: string[];
}

export interface ElectionMessage {
  type:
    | 'ELECTION_START'
    | 'ELECTION_CANDIDATE'
    | 'MASTER_ELECTED'
    | 'ELECTION_ABORT';
  fromInstanceId: string;
  timestamp: number;
  data?: any;
}

export interface CoordinationEvent {
  type:
    | 'worker_registered'
    | 'worker_disconnected'
    | 'master_changed'
    | 'election_started'
    | 'failover_initiated'
    | 'mode_changed';
  instanceId: string;
  timestamp: number;
  data?: any;
}

export type CoordinationEventCallback = (event: CoordinationEvent) => void;

export const DEFAULT_COORDINATION_CONFIG: CoordinationConfig = {
  enabled: true,
  masterPort: 9100,
  workerPortRange: [9101, 9199],
  heartbeatInterval: 5000,
  registrationTimeout: 10000,
  mode: InstanceMode.AUTO, // auto-detect
};

export const DEFAULT_FAILOVER_CONFIG: FailoverConfig = {
  enabled: true,
  masterHealthCheckInterval: 3000,
  masterTimeoutThreshold: 10000,
  electionTimeout: 5000,
  backoffMultiplier: 1.5,
  quorumSize: 0, // 0 = majority
  backupMaster: true,
};

export const TOOL_ROUTING_STRATEGY: ToolRoutingStrategy = {
  workspace_specific: [
    'get_diagnostics',
    // 'get_file_content',
    'find_references',
    'find_definition',
    'get_symbols',
    'get_selection', // Now workspace-specific with optional targeting
  ],
  active_context: [
    // Moved get_selection to workspace_specific for better control
  ],
  aggregated: [
    'get_open_files',
    'get_workspace_symbols',
    'search_files',
    'get_workspaces', // Master-only tool
    'get_instances', // Show all connected instances
  ],
};

export function createInstanceId(): string {
  return randomUUID();
}

export function createWorkerInfo(
  workspaceName: string,
  workspacePath: string,
  port: number,
  capabilities: string[],
  version: string = '0.1.0',
): WorkerInfo {
  return {
    instanceId: createInstanceId(),
    workspaceName,
    workspacePath,
    port,
    capabilities,
    lastSeen: Date.now(),
    status: 'active',
    registeredAt: Date.now(),
    version,
  };
}

export function createMasterState(instanceId: string): MasterState {
  return {
    registeredWorkers: new Map(),
    activeSessions: new Map(),
    toolCallHistory: [],
    workspaceRouting: new Map(),
    performanceMetrics: {
      averageResponseTime: 0,
      totalToolCalls: 0,
      successRate: 1.0,
      lastUpdated: Date.now(),
    },
    startedAt: Date.now(),
    instanceId,
  };
}
