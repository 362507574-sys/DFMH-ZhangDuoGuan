import { lstat, readFile } from 'node:fs/promises';

const MAX_JSON_BYTES = 1024 * 1024;

export function parseStrictJson(text, { label = 'JSON', allowedKeys } = {}) {
  if (typeof text !== 'string') throw new TypeError(`${label} must be text`);
  if (text.charCodeAt(0) === 0xFEFF) throw new Error(`${label} must not contain a BOM`);
  assertNoDuplicateJsonKeys(text, label);
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`, { cause: error });
  }
  assertPlainObject(value, label);
  if (allowedKeys !== undefined) {
    if (!(allowedKeys instanceof Set)) throw new TypeError('allowedKeys must be a Set');
    for (const key of Object.keys(value)) {
      if (!allowedKeys.has(key)) throw new Error(`${label} has unexpected field: ${key}`);
    }
  }
  return value;
}

export async function readStrictJson(filePath, options = {}) {
  const details = await lstat(filePath).catch((error) => {
    throw new Error(`${options.label ?? 'JSON file'} cannot be read: ${error.message}`, { cause: error });
  });
  if (!details.isFile() || details.size > (options.maxBytes ?? MAX_JSON_BYTES)) {
    throw new Error(`${options.label ?? 'JSON file'} must be a regular bounded file`);
  }
  return parseStrictJson(await readFile(filePath, 'utf8'), options);
}

export function assertPlainObject(value, label = 'value') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertNoDuplicateJsonKeys(source, label) {
  let index = 0;
  const skip = () => { while (/\s/u.test(source[index] ?? '')) index += 1; };
  const parseString = () => {
    if (source[index] !== '"') throw new SyntaxError(`${label} expected a JSON string at ${index}`);
    const start = index++;
    while (index < source.length) {
      if (source[index] === '"') return JSON.parse(source.slice(start, ++index));
      if (source[index] === '\\') index += source[index + 1] === 'u' ? 6 : 2;
      else index += 1;
    }
    throw new SyntaxError(`${label} contains an unterminated JSON string`);
  };
  const parseValue = () => {
    skip();
    if (source[index] === '{') return parseObject();
    if (source[index] === '[') return parseArray();
    if (source[index] === '"') return parseString();
    const start = index;
    while (index < source.length && !/[\s,\]}]/u.test(source[index])) index += 1;
    if (start === index) throw new SyntaxError(`${label} expected a JSON value at ${index}`);
    return undefined;
  };
  const parseObject = () => {
    const keys = new Set();
    index += 1;
    skip();
    if (source[index] === '}') { index += 1; return; }
    for (;;) {
      skip();
      const key = parseString();
      if (keys.has(key)) throw new SyntaxError(`${label} contains duplicate JSON key: ${key}`);
      keys.add(key);
      skip();
      if (source[index++] !== ':') throw new SyntaxError(`${label} expected a colon`);
      parseValue();
      skip();
      if (source[index] === '}') { index += 1; return; }
      if (source[index++] !== ',') throw new SyntaxError(`${label} expected a comma`);
    }
  };
  const parseArray = () => {
    index += 1;
    skip();
    if (source[index] === ']') { index += 1; return; }
    for (;;) {
      parseValue();
      skip();
      if (source[index] === ']') { index += 1; return; }
      if (source[index++] !== ',') throw new SyntaxError(`${label} expected a comma`);
    }
  };
  skip();
  parseValue();
  skip();
  if (index !== source.length) throw new SyntaxError(`${label} contains trailing JSON content`);
}
