import { EventBus } from '../shared/event-bus';
import { RestockQueue } from './restock-queue';
import { StockScheduler } from './scheduler';

export const StockProviders = {
  providers: [RestockQueue, StockScheduler, EventBus],
};
