import { AuditTrail } from './notify/audit-trail';
import { RestockMailer } from './notify/restock-mailer';
import { EventBus } from './shared/event-bus';
import { RestockQueue } from './stock/restock-queue';
import { StockScheduler } from './stock/scheduler';

const bus = new EventBus();
const scheduler = new StockScheduler(new RestockQueue(), bus);
new RestockMailer(bus);
new AuditTrail(bus);
setInterval(() => void scheduler.tick(), 60_000);
