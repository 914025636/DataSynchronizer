import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { MarketStreamEvent } from './market_streams';
import { logger } from '../logger';

export class MarketOutbox {
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private counter = 0;

  constructor(private readonly directory: string, private readonly send: (stream: string, event: MarketStreamEvent) => Promise<string>) {
    mkdirSync(directory, { recursive: true });
    this.schedule();
  }

  append(stream: string, event: MarketStreamEvent): string {
    if (this.stopped) throw new Error('Market outbox is closed');
    const id = `${Date.now()}-${String(this.counter++).padStart(10, '0')}-${randomBytes(8).toString('hex')}`;
    const temporary = join(this.directory, `${id}.tmp`);
    const descriptor = openSync(temporary, 'wx');
    try {
      writeFileSync(descriptor, JSON.stringify({ stream, event }));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, join(this.directory, `${id}.json`));
    this.schedule();
    return id;
  }

  private schedule(): void {
    if (this.stopped || this.timer || this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drain().catch((error) => logger.error('Market outbox retained pending messages', error));
    }, 1000);
    this.timer.unref();
  }

  async drain(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      for (const name of readdirSync(this.directory).filter((file) => file.endsWith('.json') || file.endsWith('.tmp')).sort()) {
        if (this.stopped) break;
        const filename = join(this.directory, name);
        if (!existsSync(filename)) continue;
        const message = JSON.parse(readFileSync(filename, 'utf8'));
        await this.send(message.stream, message.event);
        unlinkSync(filename);
      }
    })();
    try {
      await this.running;
    } finally {
      this.running = null;
      this.schedule();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}