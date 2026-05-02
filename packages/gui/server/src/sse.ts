import type { Response } from 'express';

export interface SseEvent {
  type: string;
  payload: unknown;
}

export class SseHub {
  private clients = new Set<Response>();

  attach(res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(': connected\n\n');
    this.clients.add(res);
    res.on('close', () => {
      this.clients.delete(res);
    });
  }

  broadcast(event: SseEvent): void {
    const line = `event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
    for (const client of this.clients) {
      client.write(line);
    }
  }

  broadcastRaw(type: string, payload: unknown): void {
    this.broadcast({ type, payload });
  }
}
