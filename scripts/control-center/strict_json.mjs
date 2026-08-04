export function parseStrictJson(source, label = 'JSON') {
  if (typeof source !== 'string') throw new TypeError(`${label} source must be a string`);
  assertNoDuplicateJsonKeys(source, label);
  return JSON.parse(source);
}

function assertNoDuplicateJsonKeys(source, label) {
  let index = 0;
  const parseString = () => {
    if (source[index] !== '"') throw new SyntaxError(`${label} expected a JSON string at ${index}`);
    const start = index;
    index += 1;
    while (index < source.length) {
      if (source[index] === '"') {
        index += 1;
        return JSON.parse(source.slice(start, index));
      }
      if (source[index] === '\\') index += source[index + 1] === 'u' ? 6 : 2;
      else index += 1;
    }
    throw new SyntaxError(`${label} contains an unterminated JSON string`);
  };
  const skip = () => { while (/\s/u.test(source[index] || '')) index += 1; };
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
      if (source[index] !== ':') throw new SyntaxError(`${label} expected a colon at ${index}`);
      index += 1;
      parseValue();
      skip();
      if (source[index] === '}') { index += 1; return; }
      if (source[index] !== ',') throw new SyntaxError(`${label} expected a comma at ${index}`);
      index += 1;
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
      if (source[index] !== ',') throw new SyntaxError(`${label} expected a comma at ${index}`);
      index += 1;
    }
  };
  skip();
  parseValue();
  skip();
  if (index !== source.length) throw new SyntaxError(`${label} contains trailing JSON content`);
}
