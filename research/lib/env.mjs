/*
 * Load .env into process.env, with no dependency.
 *
 * Imported FIRST by the CLI, before any module that reads a key at load time.
 * ES module imports evaluate in source order, so a bare `import './lib/env.mjs'`
 * on the first line is enough to guarantee the keys are present by the time the
 * model router picks a provider.
 *
 * Real environment variables always win, so a one-off `KEY=... node validate.mjs`
 * overrides the file rather than being silently ignored.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function loadEnv(file = path.join(root, '.env')) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return 0;                   // no .env is a normal state, not an error
  }

  let n = 0;
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || line.trim().startsWith('#')) continue;
    const key = m[1];
    let value = m[2].trim();
    // Strip matched surrounding quotes, keeping any inside the value.
    if (value.length > 1 && /^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1);
    if (process.env[key] === undefined) {
      process.env[key] = value;
      n++;
    }
  }
  return n;
}

loadEnv();
