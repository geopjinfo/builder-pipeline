export class RestockQueue {
  private readonly pending: string[] = [];

  enqueue(sku: string): void {
    this.pending.push(sku);
  }

  async dispatchBatch(): Promise<number> {
    const sent = this.pending.length;
    this.pending.length = 0;
    return sent;
  }
}
