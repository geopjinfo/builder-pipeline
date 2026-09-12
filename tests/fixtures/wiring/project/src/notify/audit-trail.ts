import { EventBus } from '../shared/event-bus';
import { AUDITED } from './audited';

export class AuditTrail {
  readonly recorded: string[] = [];

  constructor(bus: EventBus) {
    for (const name of AUDITED) bus.subscribe(name, (event) => this.recorded.push(event.name));
  }
}
