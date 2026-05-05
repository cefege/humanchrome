// CJS shim for the ESM-only `uuid` package so jest's default CommonJS
// transform can resolve `import { v4 } from 'uuid'` in test mode without
// needing to teach ts-jest to compile node_modules ESM. We only re-export
// the surface the bridge actually uses (`v4`), but expose a couple of the
// other helpers in case future tests need them.
const crypto = require('node:crypto');

function v4() {
  return crypto.randomUUID();
}

module.exports = {
  v4,
  default: { v4 },
};
