/** Logger minimal en JSON de ligne — lisible par n'importe quel agregateur, zero dependance. */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env['LOG_LEVEL'] as Level) ?? 'info'] ?? LEVELS.info;

function emit(level: Level, scope: string, message: string, extra?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    scope,
    message,
    ...(extra ?? {}),
  });
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, e) => emit('debug', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    error: (m, e) => emit('error', scope, m, e),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export const logger = createLogger('scarpcrap');

/** Serialise une erreur inconnue en quelque chose de loggable. */
export function errInfo(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { err: err.message, stack: err.stack?.split('\n').slice(0, 4).join(' | ') };
  }
  return { err: String(err) };
}
