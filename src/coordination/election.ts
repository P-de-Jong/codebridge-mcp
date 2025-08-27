import * as http from 'http';
import {
  ElectionCandidate,
  ElectionMessage,
  WorkerInfo,
  WorkspaceInfo,
  CoordinationConfig,
  FailoverConfig,
} from './types';
import { ExtensionLogger } from '../logger';

export class LeaderElection {
  private logger: ExtensionLogger;
  private failoverConfig: FailoverConfig;
  private candidates: Map<string, ElectionCandidate> = new Map();
  private electionInProgress: boolean = false;
  private electionTimeout: NodeJS.Timeout | null = null;
  private instanceId: string;

  constructor(
    logger: ExtensionLogger,
    _config: CoordinationConfig,
    failoverConfig: FailoverConfig,
    instanceId: string,
  ) {
    this.logger = logger;
    this.failoverConfig = failoverConfig;
    this.instanceId = instanceId;
  }

  async startElection(availableWorkers: WorkerInfo[]): Promise<string> {
    if (this.electionInProgress) {
      this.logger.warn('Election already in progress');
      throw new Error('Election already in progress');
    }

    this.logger.info('Starting leader election', {
      candidateCount: availableWorkers.length,
      electionTimeout: this.failoverConfig.electionTimeout,
    });

    this.electionInProgress = true;
    this.candidates.clear();

    try {
      // Phase 1: Collect candidate information
      await this.collectCandidates(availableWorkers);

      // Phase 2: Calculate election winner
      const winner = this.calculateElectionWinner();

      // Phase 3: Broadcast election result
      await this.broadcastElectionResult(winner);

      this.logger.info('Leader election completed', {
        winner: winner.instanceId,
        totalCandidates: this.candidates.size,
      });

      return winner.instanceId;
    } catch (error) {
      this.logger.error('Leader election failed', error);
      throw error;
    } finally {
      this.electionInProgress = false;
      if (this.electionTimeout) {
        clearTimeout(this.electionTimeout);
        this.electionTimeout = null;
      }
    }
  }

  private async collectCandidates(workers: WorkerInfo[]): Promise<void> {
    const candidatePromises = workers.map((worker) =>
      this.requestCandidateInfo(worker).catch((error) => {
        this.logger.warn('Failed to get candidate info from worker', {
          worker: worker.instanceId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }),
    );

    // Wait for all responses or timeout
    const candidateResults = await Promise.race([
      Promise.allSettled(candidatePromises),
      this.createElectionTimeout(),
    ]);

    if (Array.isArray(candidateResults)) {
      candidateResults.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value) {
          const worker = workers[index];
          this.candidates.set(worker.instanceId, result.value);
        }
      });
    }

    this.logger.info('Candidate collection completed', {
      candidates: this.candidates.size,
      totalWorkers: workers.length,
    });

    // Validate quorum
    if (!this.validateQuorum(workers.length)) {
      throw new Error('Insufficient candidates for election (quorum not met)');
    }
  }

  private async requestCandidateInfo(
    worker: WorkerInfo,
  ): Promise<ElectionCandidate> {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'localhost',
        port: worker.port,
        path: '/election/candidate',
        method: 'GET',
        timeout: 5000,
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const candidateInfo = JSON.parse(data);
            resolve(candidateInfo);
          } catch (error) {
            reject(new Error(`Invalid candidate response: ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error('Candidate request timeout'));
      });

      req.end();
    });
  }

  private createElectionTimeout(): Promise<never> {
    return new Promise((_, reject) => {
      this.electionTimeout = setTimeout(() => {
        reject(new Error('Election timeout - not all candidates responded'));
      }, this.failoverConfig.electionTimeout);
    });
  }

  private validateQuorum(totalWorkers: number): boolean {
    const quorumSize =
      this.failoverConfig.quorumSize || Math.ceil(totalWorkers / 2);
    const hasQuorum = this.candidates.size >= quorumSize;

    this.logger.debug('Quorum validation', {
      candidates: this.candidates.size,
      requiredQuorum: quorumSize,
      totalWorkers,
      hasQuorum,
    });

    return hasQuorum;
  }

  private calculateElectionWinner(): ElectionCandidate {
    if (this.candidates.size === 0) {
      throw new Error('No candidates available for election');
    }

    const candidateList = Array.from(this.candidates.values());

    // Sort by election criteria (priority order)
    candidateList.sort((a, b) => {
      // 1. Workspace score (higher is better)
      if (a.workspaceScore !== b.workspaceScore) {
        return b.workspaceScore - a.workspaceScore;
      }

      // 2. Uptime (longer running is better)
      if (a.uptime !== b.uptime) {
        return b.uptime - a.uptime;
      }

      // 3. Resource usage (lower is better)
      if (a.resourceUsage !== b.resourceUsage) {
        return a.resourceUsage - b.resourceUsage;
      }

      // 4. Deterministic tiebreaker (lexicographic)
      return a.instanceId.localeCompare(b.instanceId);
    });

    const winner = candidateList[0];

    this.logger.info('Election winner calculated', {
      winner: winner.instanceId,
      workspaceScore: winner.workspaceScore,
      uptime: winner.uptime,
      resourceUsage: winner.resourceUsage,
      totalCandidates: candidateList.length,
    });

    return winner;
  }

  private async broadcastElectionResult(
    winner: ElectionCandidate,
  ): Promise<void> {
    const message: ElectionMessage = {
      type: 'MASTER_ELECTED',
      fromInstanceId: this.instanceId,
      timestamp: Date.now(),
      data: {
        newMasterId: winner.instanceId,
        electionId: `${Date.now()}-${this.instanceId}`,
      },
    };

    const broadcastPromises = Array.from(this.candidates.keys())
      .filter((id) => id !== winner.instanceId) // Don't send to the winner
      .map((instanceId) =>
        this.sendElectionMessage(instanceId, message).catch((error) => {
          this.logger.warn('Failed to notify worker of election result', {
            worker: instanceId,
            error: error instanceof Error ? error.message : String(error),
          });
        }),
      );

    await Promise.allSettled(broadcastPromises);

    this.logger.info('Election result broadcast completed', {
      winner: winner.instanceId,
      notified: broadcastPromises.length,
    });
  }

  private async sendElectionMessage(
    instanceId: string,
    message: ElectionMessage,
  ): Promise<void> {
    const candidate = this.candidates.get(instanceId);
    if (!candidate) {
      throw new Error(`Candidate ${instanceId} not found`);
    }

    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(message);
      const options = {
        hostname: 'localhost',
        port: candidate.workerInfo.port,
        path: '/election/message',
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
        reject(new Error('Election message timeout'));
      });

      req.write(postData);
      req.end();
    });
  }

  calculateWorkspaceScore(workspace: WorkspaceInfo): number {
    return (
      workspace.fileCount * 0.4 +
      workspace.gitCommits * 0.3 +
      workspace.recentActivity * 0.3
    );
  }

  isElectionInProgress(): boolean {
    return this.electionInProgress;
  }

  abortElection(): void {
    if (this.electionInProgress) {
      this.logger.warn('Aborting election in progress');
      this.electionInProgress = false;

      if (this.electionTimeout) {
        clearTimeout(this.electionTimeout);
        this.electionTimeout = null;
      }

      this.candidates.clear();
    }
  }
}
