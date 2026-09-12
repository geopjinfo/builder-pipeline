import { EventBus } from '../shared/event-bus';
import { RestockQueue } from './restock-queue';

export class StockScheduler {
  constructor(
    private readonly queue: RestockQueue,
    private readonly bus: EventBus,
  ) {}

  async tick(): Promise<void> {
    const sent = await this.queue.dispatchBatch();
    if (sent > 0) this.bus.publish({ name: 'stock.restocked.v1' });
  }
}
