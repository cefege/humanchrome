/**
 * Drop the per-worker `--localstorage-file was provided without a valid path`
 * warning Node 24+ emits when `jest-environment-node`'s teardown touches the
 * built-in `localStorage` accessor. The warning bypasses
 * `process.on('warning')` listeners (it deduplicates and fires before any
 * test code runs), so we filter the stderr fast-path instead.
 */
const NOISE = /--localstorage-file|\(Use `node --trace-warnings/;

const origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = function patchedStderrWrite(chunk, ...rest) {
  if (chunk) {
    const s =
      typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : null;
    if (s !== null && NOISE.test(s)) return true;
  }
  return origStderrWrite(chunk, ...rest);
};
