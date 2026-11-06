import { redactValue, scrubString } from './redact.js';

export type Level = 'debug' | 'info' | 'warn' | 'error';
export type Sink = (line: string) => void;

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(opts: {
  sink: Sink;
  level?: Level;
  base?: Record<string, unknown>;
  now?: () => Date;
}): Logger {
  const min = ORDER[opts.level ?? 'info'];
  const now = opts.now ?? ((): Date => new Date());
  const make = (base: Record<string, unknown>): Logger => {
    const emit = (level: Level, msg: string, fields?: Record<string, unknown>): void => {
      if (ORDER[level] < min) return;
      const record = redactValue({ ...base, ...fields }, undefined) as Record<string, unknown>;
      // `level`, `time` and `msg` are set last so a caller field cannot overwrite them.
      opts.sink(
        JSON.stringify({ ...record, level, time: now().toISOString(), msg: scrubString(msg) }),
      );
    };
    return {
      debug: (m, f) => emit('debug', m, f),
      info: (m, f) => emit('info', m, f),
      warn: (m, f) => emit('warn', m, f),
      error: (m, f) => emit('error', m, f),
      child: (f) => make({ ...base, ...f }),
    };
  };
  return make(opts.base ?? {});
}
