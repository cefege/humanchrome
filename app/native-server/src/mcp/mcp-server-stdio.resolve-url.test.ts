/**
 * resolveBridgeUrl — closes the port-walk ceiling: the stdio proxy must dial
 * the live bridge even when it walked off the config port (multi-Chrome).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { writeInstance } from '../util/instance-registry';
import { resolveBridgeUrl } from './mcp-server-stdio';

const DEFAULT = 'http://127.0.0.1:12306/mcp';
let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(resolve(tmpdir(), 'hc-resolve-url-'));
  process.env.HC_INSTANCE_REGISTRY_DIR = tmp;
});

afterAll(() => {
  delete process.env.HC_INSTANCE_REGISTRY_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  delete process.env.HUMANCHROME_URL;
  delete process.env.HUMANCHROME_PORT;
});

const inst = (port: number, pid = process.pid) =>
  writeInstance({ pid, port, extensionId: 'x', startedAt: new Date().toISOString() });

describe('resolveBridgeUrl', () => {
  test('HUMANCHROME_URL wins verbatim', () => {
    process.env.HUMANCHROME_URL = 'http://host:9/mcp';
    expect(resolveBridgeUrl(DEFAULT)).toBe('http://host:9/mcp');
  });

  test('HUMANCHROME_PORT swaps the port', () => {
    process.env.HUMANCHROME_PORT = '12399';
    expect(resolveBridgeUrl(DEFAULT)).toBe('http://127.0.0.1:12399/mcp');
  });

  test('keeps config port when it is live', () => {
    inst(12306);
    expect(resolveBridgeUrl(DEFAULT)).toBe(DEFAULT);
  });

  test('adopts the sole live bridge when config port is dead (port-walk)', () => {
    inst(12307);
    expect(resolveBridgeUrl(DEFAULT)).toBe('http://127.0.0.1:12307/mcp');
  });

  test('ambiguous (>1 live) falls back to config default', () => {
    inst(12307); // keyed by process.pid
    inst(12308, process.ppid); // distinct, also-alive pid → two live entries
    expect(resolveBridgeUrl(DEFAULT)).toBe(DEFAULT);
  });

  test('no registry entries falls back to config default', () => {
    expect(resolveBridgeUrl(DEFAULT)).toBe(DEFAULT);
  });
});
