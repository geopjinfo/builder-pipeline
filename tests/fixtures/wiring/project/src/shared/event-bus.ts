type Handler = (event: { name: string }) => void;

export class EventBus {
  private readonly handlers = new Map<string, Handler[]>();

  subscribe(name: string, handler: Handler): void {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
  }

  publish(event: { name: string }): void {
    for (const handler of this.handlers.get(event.name) ?? []) handler(event);
  }
}
