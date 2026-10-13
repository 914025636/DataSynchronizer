import { mkdirSync, promises as fsp, readdirSync, readFileSync, renameSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { MarketStreamEvent } from './market_streams';
import { logger } from '../logger';

export type OutboxMessage = { stream: string; event: MarketStreamEvent };

type PendingAppend = {
  message: OutboxMessage;
  resolve: (id: string) => void;
  reject: (error: unknown) => void;
};

const batchDelayMs = Number(process.env.MARKET_OUTBOX_BATCH_MS || 20);
const batchMaxSize = Number(process.env.MARKET_OUTBOX_BATCH_SIZE || 1000);
const drainRetryMs = 1000;

export class MarketOutbox {
  private buffer: PendingAppend[] = [];
  private readonly committed: string[];
  private commitTimer: NodeJS.Timeout | null = null;
  private committing: Promise<void> | null = null;
  private drainTimer: NodeJS.Timeout | null = null;
  private draining: Promise<void> | null = null;
  private stopped = false;
  private counter = 0;

  constructor(private readonly directory: string, private readonly send: (messages: OutboxMessage[]) => Promise<void>) {
    mkdirSync(directory, { recursive: true });
    this.committed = this.recover();
    this.scheduleDrain(0);
  }

  // Resolves once the message is fsynced as part of a batch file.
  append(stream: string, event: MarketStreamEvent): Promise<string> {
    if (this.stopped) return Promise.reject(new Error('Market outbox is closed'));
    return new Promise((resolve, reject) => {
      this.buffer.push({ message: { stream, event }, resolve, reject });
      this.scheduleCommit();
    });
  }

  async drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      while (!this.stopped && this.committed.length > 0) {
        const name = this.committed[0];
        const messages = await this.readBatch(name);
        if (messages) {
          await this.send(messages);
          await fsp.unlink(join(this.directory, name));
        }
        this.committed.shift();
      }
    })();
    try {
      await this.draining;
    } finally {
      this.draining = null;
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = null;
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = null;
    while (this.committing || this.buffer.length > 0) await this.startCommit();
  }

  private recover(): string[] {
    for (const name of readdirSync(this.directory).filter((file) => file.endsWith('.tmp'))) {
      const temporary = join(this.directory, name);
      const base = temporary.slice(0, -'.tmp'.length);
      try {
        JSON.parse(readFileSync(temporary, 'utf8'));
        renameSync(temporary, `${base}.json`);
      } catch (error) {
        renameSync(temporary, `${base}.corrupt`);
        logger.error(`Market outbox quarantined incomplete batch ${name}`, error);
      }
    }
    return readdirSync(this.directory).filter((file) => file.endsWith('.json')).sort();
  }

  private scheduleCommit(): void {
    if (this.committing) return;
    if (this.stopped || this.buffer.length >= batchMaxSize) {
      if (this.commitTimer) clearTimeout(this.commitTimer);
      this.commitTimer = null;
      this.startCommit();
    } else if (!this.commitTimer) {
      this.commitTimer = setTimeout(() => {
        this.commitTimer = null;
        this.startCommit();
      }, batchDelayMs);
    }
  }

  private startCommit(): Promise<void> {
    if (!this.committing) {
      this.committing = this.commitBuffered().finally(() => {
        this.committing = null;
        if (this.buffer.length > 0) this.scheduleCommit();
      });
    }
    return this.committing;
  }

  // Messages appended while a batch is being fsynced form the next batch.
  private async commitBuffered(): Promise<void> {
    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, batchMaxSize);
      try {
        const name = await this.writeBatch(batch.map((item) => item.message));
        this.committed.push(name);
        batch.forEach((item) => item.resolve(name));
        this.scheduleDrain(0);
      } catch (error) {
        batch.forEach((item) => item.reject(error));
      }
    }
  }

  private async writeBatch(messages: OutboxMessage[]): Promise<string> {
    const id = `${Date.now()}-${String(this.counter++).padStart(10, '0')}-${randomBytes(8).toString('hex')}`;
    const temporary = join(this.directory, `${id}.tmp`);
    const handle = await fsp.open(temporary, 'wx');
    try {
      await handle.writeFile(JSON.stringify(messages));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(temporary, join(this.directory, `${id}.json`));
    return `${id}.json`;
  }

  private async readBatch(name: string): Promise<OutboxMessage[] | null> {
    const filename = join(this.directory, name);
    try {
      const parsed = JSON.parse(await fsp.readFile(filename, 'utf8'));
      // Files written before batching hold a single message object.
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (!(error instanceof SyntaxError)) throw error;
      await fsp.rename(filename, `${filename}.corrupt`);
      logger.error(`Market outbox quarantined unreadable batch ${name}`, error);
      return null;
    }
  }

  private scheduleDrain(delay: number): void {
    if (this.stopped || this.draining || this.drainTimer || this.committed.length === 0) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.drain().then(
        () => this.scheduleDrain(0),
        (error) => {
          logger.error('Market outbox retained pending messages', error);
          this.scheduleDrain(drainRetryMs);
        },
      );
    }, delay);
    this.drainTimer.unref();
  }
}