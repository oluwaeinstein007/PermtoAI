export interface PurchaseLog {
  name: string;
}

export class SampleService {
  async addLog(log: PurchaseLog): Promise<string> {
    console.log(`[SampleService] Processing sample log for: ${log.name}`);
    return `SAMPLE-${Date.now()}`;
  }
}