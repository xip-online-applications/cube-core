import SqlString from 'sqlstring';
import R from 'ramda';

import { getEnv, levelEnabled } from '@cubejs-backend/shared';
import type { LogLevel, LoggerFn, LoggerFnParams } from '@cubejs-backend/shared';

export type { LogLevel } from '@cubejs-backend/shared';

type Color = '31' | '32' | '33';

const colors: Record<'red' | 'green' | 'yellow', Color> = {
  red: '31', // ERROR
  green: '32', // INFO
  yellow: '33', // WARNING
};

const withColor = (str: string, color: Color = colors.green): string => `\u001b[${color}m${str}\u001b[0m`;

interface FormatOptions {
  requestId?: string;
  duration?: number;
  query?: string | Record<string, any>;
  values?: any[];
  allSqlLines?: boolean;
  showRestParams?: boolean;
  [key: string]: any;
}

const format = ({ requestId, duration, allSqlLines, query, values, showRestParams, ...json }: FormatOptions): string => {
  const restParams = JSON.stringify(json, null, 2);
  const durationStr = duration ? `(${duration}ms)` : '';
  const prefix = `${requestId || ''} ${durationStr}`.trim();

  if (query && values) {
    const queryMaxLines = 50;
    let queryStr = typeof query === 'string' ? query : JSON.stringify(query);
    queryStr = queryStr.replaceAll(/\$(\d+)/g, '?');
    let formatted = SqlString.format(queryStr, values).split('\n');

    if (formatted.length > queryMaxLines && !allSqlLines) {
      formatted = R.take(queryMaxLines / 2, formatted)
        .concat(['.....', '.....', '.....'])
        .concat(R.takeLast(queryMaxLines / 2, formatted));
    }

    return `${prefix}\n--\n  ${formatted.join('\n')}\n--${showRestParams ? `\n${restParams}` : ''}`;
  } else if (query) {
    return `${prefix}\n--\n${JSON.stringify(query, null, 2)}\n--${showRestParams ? `\n${restParams}` : ''}`;
  }

  return `${prefix}${showRestParams ? `\n${restParams}` : ''}`;
};

export const devLogger = (filterByLevel: LogLevel) => (type: string, { error, warning, ...restParams }: LoggerFnParams): void => {
  const logWarning = () => console.log(
    `${withColor(type, colors.yellow)}: ${format({ ...restParams, allSqlLines: true, showRestParams: true })} \n${withColor(warning || '', colors.yellow)}`
  );

  const logError = () => console.log(
    `${withColor(type, colors.red)}: ${format({ ...restParams, allSqlLines: true, showRestParams: true })} \n${error}`
  );

  const logDetails = (showRestParams?: boolean) => console.log(
    `${withColor(type)}: ${format({ ...restParams, showRestParams })}`
  );

  if (error) {
    logError();
    return;
  }

  // eslint-disable-next-line default-case
  switch (filterByLevel.toLowerCase()) {
    case 'trace': {
      if (!error && !warning) {
        logDetails(true);
        break;
      }
    }
    // falls through, trick from 90x, levels inheritance, David Blaine: Street Magic
    case 'debug':
    case 'info': {
      if (!error && !warning && [
        'Executing SQL',
        'Streaming SQL',
        'Executing Load Pre Aggregation SQL',
        'Load Request Success',
        'Performing query',
        'Performing query completed',
        'Streaming successfully completed',
      ].includes(type)) {
        logDetails();
        break;
      }
    }
    // falls through, trick from 90x, levels inheritance, David Blaine: Street Magic
    case 'warn': {
      if (!error && warning) {
        logWarning();
        break;
      }
    }
    // falls through, trick from 90x, levels inheritance, David Blaine: Street Magic
    case 'error': {
      if (error) {
        logError();
        break;
      }
    }
  }
};

const resolveProdLevel = ({ level, error, warning }: LoggerFnParams): LogLevel => {
  if (level) {
    return level;
  }
  if (error) {
    return 'error';
  }
  if (warning) {
    return 'warn';
  }
  // Legacy info-style events ('Executing SQL', 'Load Request', ...) carry no level and are noisy
  return 'debug';
};

export const prodLogger = (filterByLevel: LogLevel) => (event: string, params: LoggerFnParams): void => {
  const level = resolveProdLevel(params);

  if (!levelEnabled(filterByLevel.toLowerCase() as LogLevel, level)) {
    return;
  }

  const {
    level: _level, timestamp, message: _message, event: _event, pod: _pod, ts: _ts, ...restParams
  } = params as LoggerFnParams & Record<string, unknown>;

  const line = {
    ...restParams,
    ts: timestamp ?? new Date().toISOString(),
    level,
    event,
    pod: process.env.HOSTNAME ?? null,
  };

  let serialized: string;
  try {
    serialized = JSON.stringify(line, safeReplacer());
  } catch (e) {
    serialized = JSON.stringify({
      ts: line.ts, level, event, pod: line.pod, serializationError: true,
    });
  }

  process.stdout.write(`${serialized}\n`);
};

const STACK_LIMIT = 2000;

// Handles BigInt, Error and circular references; a fresh replacer per call as it keeps state
const safeReplacer = () => {
  const ancestors: unknown[] = [];
  return function replacer(this: unknown, _key: string, value: unknown): unknown {
    if (typeof value === 'bigint') {
      return value.toString();
    }
    let v = value;
    if (v instanceof Error) {
      v = { name: v.name, message: v.message, stack: v.stack?.slice(0, STACK_LIMIT) };
    }
    if (typeof v === 'object' && v !== null) {
      // `this` is the holder of the current key; drop ancestors that are not on the current path
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
        ancestors.pop();
      }
      if (ancestors.includes(value)) {
        return '[Circular]';
      }
      ancestors.push(v);
    }
    return v;
  };
};

export const logStartup = (logger: LoggerFn, { version, devMode }: { version: string, devMode: boolean }): void => {
  logger('cube.startup', {
    level: 'info',
    logLevel: getEnv('logLevel') ?? 'info', // getEnv('logLevel') has no default
    slowQueryMs: getEnv('logSlowQueryMs'),
    debugFullQuery: getEnv('logDebugFullQuery'),
    version,
    devMode,
  });
};

export const createLogger = (production: boolean, filterByLevel: LogLevel = 'info'): LoggerFn => {
  switch (filterByLevel.toLowerCase()) {
    case 'trace':
    case 'debug':
    case 'info':
    case 'warn':
    case 'error':
      break;
    default:
      throw new Error(`Invalid log level: ${filterByLevel}`);
  }

  if (production) {
    return prodLogger(filterByLevel);
  } else {
    return devLogger(filterByLevel);
  }
};
