const MAX_LOG_STRING_LENGTH = 1800;
const MAX_LOG_STACK_LINES = 8;
const MAX_LOG_ARRAY_ITEMS = 25;
const MAX_LOG_OBJECT_KEYS = 40;
const SENSITIVE_KEY_PATTERN = /(?:authorization|cookie|token|api[_-]?key|sourceToken|source_token|password|secret)/iu;
const SENSITIVE_QUERY_PATTERN = /([?&](?:token|api[_-]?key|apikey|key|sourceToken|source_token|password|secret|authorization)=)[^&#\s]+/giu;

const truncateString = (value) => {
  const text = String(value);
  if (text.length <= MAX_LOG_STRING_LENGTH) {
    return text.replace(SENSITIVE_QUERY_PATTERN, '$1REDACTED');
  }

  return `${text.slice(0, MAX_LOG_STRING_LENGTH).replace(SENSITIVE_QUERY_PATTERN, '$1REDACTED')}...<truncated ${text.length - MAX_LOG_STRING_LENGTH} chars>`;
};

const serializeError = (error) => {
  if (!(error instanceof Error)) {
    return error;
  }

  return {
    name: error.name,
    message: error.message,
    code: error.code,
    statusCode: error.statusCode,
    stack: typeof error.stack === 'string'
      ? error.stack.split('\n').slice(0, MAX_LOG_STACK_LINES).join('\n')
      : undefined
  };
};

const sanitizeLogValue = (value, depth = 0, seen = new WeakSet()) => {
  if (value instanceof Error) {
    return sanitizeLogValue(serializeError(value), depth, seen);
  }

  if (typeof value === 'string') {
    return truncateString(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'function') {
    return `[Function ${value.name || 'anonymous'}]`;
  }

  if (typeof value !== 'object') {
    return String(value);
  }

  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (depth >= 4) {
    return '[MaxDepth]';
  }

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_LOG_ARRAY_ITEMS)
      .map((entry) => sanitizeLogValue(entry, depth + 1, seen));
    if (value.length > MAX_LOG_ARRAY_ITEMS) {
      items.push(`... ${value.length - MAX_LOG_ARRAY_ITEMS} more`);
    }
    return items;
  }

  const output = {};
  const entries = Object.entries(value).slice(0, MAX_LOG_OBJECT_KEYS);
  for (const [key, entryValue] of entries) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? 'REDACTED'
      : sanitizeLogValue(entryValue, depth + 1, seen);
  }

  const extraCount = Object.keys(value).length - entries.length;
  if (extraCount > 0) {
    output.__truncatedKeys = extraCount;
  }

  return output;
};

const writeLog = (level, message, context = {}) => {
  const payload = {
    level,
    message,
    time: new Date().toISOString(),
    ...Object.fromEntries(Object.entries(context).map(([key, value]) => [
      key,
      SENSITIVE_KEY_PATTERN.test(key) ? 'REDACTED' : sanitizeLogValue(value)
    ]))
  };

  const line = JSON.stringify(payload);

  if (level === 'error') {
    console.error(line);
    return;
  }

  if (level === 'warn') {
    console.warn(line);
    return;
  }

  console.log(line);
};

export const logger = Object.freeze({
  info(message, context) {
    writeLog('info', message, context);
  },
  warn(message, context) {
    writeLog('warn', message, context);
  },
  error(message, context) {
    writeLog('error', message, context);
  }
});
