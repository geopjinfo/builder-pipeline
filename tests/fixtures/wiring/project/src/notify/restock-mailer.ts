import { EventBus } from '../shared/event-bus';

export class RestockMailer {
  readonly sent: string[] = [];

  constructor(bus: EventBus) {
    bus.subscribe('stock.restocked.v1', (event) => this.sent.push(event.name));
  }
}
