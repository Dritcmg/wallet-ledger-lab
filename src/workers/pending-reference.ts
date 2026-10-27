import { FinanceService } from '../application/finance.service';
import { PeriodicWorker } from './lifecycle';

export class PendingReferenceWorker extends PeriodicWorker {
  protected readonly workerName = 'pending-reference';
  constructor(private readonly finance: FinanceService) { super(); }
  runOnce(): Promise<number> { return this.finance.retryPendingReferences(50); }
}
