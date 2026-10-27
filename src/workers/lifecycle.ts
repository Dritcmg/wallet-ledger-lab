import { config } from '../config';
import { logger } from '../infra/observability';

export function backoffSeconds(attempt: number): number {
  return Math.min(900, 2 ** Math.min(10, Math.max(0, attempt - 1)));
}
export async function drain(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(() => true, () => true),
      new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally { if (timeout) clearTimeout(timeout); }
}

export abstract class PeriodicWorker {
  private active = false;
  private task?: Promise<void>;
  private wake?: () => void;
  protected abstract readonly workerName: string;
  abstract runOnce(): Promise<number>;

  start(): void {
    if (this.active) return;
    this.active = true;
    this.task = this.loop();
  }
  private async loop(): Promise<void> {
    while (this.active) {
      try { await this.runOnce(); }
      catch { logger.error('worker_iteration_failed', { worker: this.workerName, code: 'INFRASTRUCTURE_UNAVAILABLE' }); }
      if (this.active) await new Promise<void>(resolve => {
        const timer = setTimeout(() => { this.wake = undefined; resolve(); }, config.workerIntervalMs);
        this.wake = () => { clearTimeout(timer); this.wake = undefined; resolve(); };
      });
    }
  }
  async stop(): Promise<void> {
    this.active = false;
    this.wake?.();
    if (this.task && !await drain(this.task, Math.max(1, Math.floor(config.shutdownTimeoutMs * 0.7)))) {
      logger.info('worker_drain_timed_out', { worker: this.workerName });
    }
  }
}
