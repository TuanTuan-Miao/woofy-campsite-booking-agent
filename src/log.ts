export class WorkflowLogger {
  private readonly entries: string[] = [];

  info(message: string): void {
    const line = `[${new Date().toISOString()}] ${message}`;
    this.entries.push(line);
    console.log(line);
  }

  snapshot(): string[] {
    return [...this.entries];
  }
}
