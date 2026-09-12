export class LedgerQueue {
  private readonly entries: string[] = [];

  record(entry: string): void {
    this.entries.push(entry);
  }

  async drainPending(): Promise<number> {
    const drained = this.entries.length;
    this.entries.length = 0;
    return drained;
  }
}
