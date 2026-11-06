// Alert stream shell (ARCHITECTURE 32.1-32.3). This ticket delivers the transport only: headers, the 15 s `ping`,
// the per-principal connection registry and the `event: closed` on drain. Alert replay and LISTEN/NOTIFY belong to
// the notifications module. The release check ran before this handler (it takes `clientRelease` from the query).
import { Controller, Get, Inject, Injectable, Req, Res } from '@nestjs/common';
import type { Req as HttpReq, Res as HttpRes } from './http.js';
import { Route } from './route.js';

export const PING_MS = 15_000;

@Injectable()
export class StreamRegistry {
  private readonly open = new Set<HttpRes>();

  add(res: HttpRes): void {
    this.open.add(res);
    res.on('close', () => this.open.delete(res));
  }

  count(): number {
    return this.open.size;
  }

  /** A draining instance closes its streams with a final `event: closed` (32.3). */
  drain(): void {
    for (const res of this.open) {
      res.write('event: closed\ndata: {}\n\n');
      res.end();
    }
    this.open.clear();
  }
}

@Controller('api/v1/alerts')
export class AlertStreamController {
  constructor(@Inject(StreamRegistry) private readonly registry: StreamRegistry) {}

  @Get('stream')
  @Route({ permission: 'notifications.alert.read', resolver: 'principal', routeClass: 'stream' })
  stream(@Req() _req: HttpReq, @Res() res: HttpRes): void {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('retry: 5000\n\n');
    this.registry.add(res);
    const timer = setInterval(() => res.write('event: ping\ndata:\n\n'), PING_MS);
    timer.unref();
    res.on('close', () => clearInterval(timer));
  }
}
