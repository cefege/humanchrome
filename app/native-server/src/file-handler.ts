import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as net from 'net';
import { lookup as dnsLookup } from 'dns/promises';
import { FileOperationPayloadSchema } from 'humanchrome-shared';
import { withContext } from './util/logger';

const log = withContext({ component: 'file-handler' });

const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024; // 100 MB

// Reject loopback, link-local, and RFC1918 ranges so the bridge can't be used
// to probe internal services or fetch cloud-metadata endpoints.
function isPrivateIp(addr: string): boolean {
  if (!net.isIP(addr)) return false;
  if (net.isIPv4(addr)) {
    const octets = addr.split('.').map(Number);
    return (
      octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 169 && octets[1] === 254) ||
      octets[0] === 127 ||
      octets[0] === 0
    );
  }
  // IPv6: ::1, fc00::/7, fe80::/10, ::ffff:<v4>
  const lower = addr.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb')
  )
    return true;
  if (lower.startsWith('::ffff:')) return isPrivateIp(lower.replace('::ffff:', ''));
  return false;
}

async function assertSafeUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`URL scheme not allowed: ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost') throw new Error('Loopback URLs are not allowed');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Private/loopback IP not allowed');
  } else {
    const resolved = await dnsLookup(host, { all: true }).catch(() => []);
    for (const r of resolved) {
      if (isPrivateIp(r.address)) throw new Error('Hostname resolves to private/loopback IP');
    }
  }
  return url;
}

/**
 * File handler for managing file uploads through the native messaging host
 */
export class FileHandler {
  private tempDir: string;

  constructor() {
    // Create a temp directory for file operations
    this.tempDir = path.join(os.tmpdir(), 'humanchrome-uploads');
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * Handle file preparation request from the extension
   */
  async handleFileRequest(request: any): Promise<any> {
    // Runtime-validate at the IPC boundary. The native-messaging-host already
    // runs an outer NativeMessageSchema check on the envelope; this one
    // validates the inner payload shape so we don't blindly destructure
    // fields off arbitrary input.
    const parsed = FileOperationPayloadSchema.safeParse(request);
    if (!parsed.success) {
      return {
        success: false,
        error: `Invalid file_operation payload: ${parsed.error.issues[0]?.message ?? 'schema validation failed'}`,
      };
    }
    const { action, fileUrl, base64Data, fileName, filePath, traceFilePath, insightName } =
      parsed.data;

    try {
      switch (action) {
        case 'prepareFile':
          if (fileUrl) {
            return await this.downloadFile(fileUrl, fileName);
          } else if (base64Data) {
            return await this.saveBase64File(base64Data, fileName);
          } else if (filePath) {
            return await this.verifyFile(filePath);
          }
          break;

        case 'readBase64File': {
          if (!filePath) return { success: false, error: 'filePath is required' };
          return await this.readBase64File(filePath);
        }

        case 'cleanupFile':
          if (!filePath) return { success: false, error: 'filePath is required' };
          return await this.cleanupFile(filePath);

        case 'analyzeTrace': {
          const targetPath = traceFilePath || filePath;
          if (!targetPath) {
            return { success: false, error: 'traceFilePath is required' };
          }
          try {
            // With tsconfig moduleResolution=NodeNext, relative ESM imports need explicit .js extension
            const { analyzeTraceFile } = await import('./trace-analyzer.js');
            const res = await analyzeTraceFile(targetPath, insightName);
            return { success: true, ...res };
          } catch (e: any) {
            return { success: false, error: e?.message || String(e) };
          }
        }

        default:
          return {
            success: false,
            error: `Unknown file action: ${action}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Download a file from URL and save to temp directory
   */
  private async downloadFile(fileUrl: string, fileName?: string): Promise<any> {
    try {
      const safeUrl = await assertSafeUrl(fileUrl);
      const response = await fetch(safeUrl.toString(), { redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) {
        throw new Error('Redirects not allowed (could re-target an internal IP)');
      }
      if (!response.ok) {
        throw new Error(`Failed to download file: ${response.statusText}`);
      }

      const declaredSize = Number(response.headers.get('content-length') || '0');
      if (declaredSize > MAX_DOWNLOAD_BYTES) {
        throw new Error(`File too large: ${declaredSize} bytes (cap ${MAX_DOWNLOAD_BYTES})`);
      }

      const finalFileName = fileName || this.generateFileName(fileUrl);
      const filePath = path.join(this.tempDir, finalFileName);

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_DOWNLOAD_BYTES) {
        throw new Error(`File too large after download: ${buffer.length} bytes`);
      }

      fs.writeFileSync(filePath, buffer);

      return {
        success: true,
        filePath: filePath,
        fileName: finalFileName,
        size: buffer.length,
      };
    } catch (error) {
      throw new Error(`Failed to download file from URL: ${error}`, { cause: error });
    }
  }

  /**
   * Save base64 data as a file
   */
  private async saveBase64File(base64Data: string, fileName?: string): Promise<any> {
    try {
      // Remove data URL prefix if present
      const base64Content = base64Data.replace(/^data:.*?;base64,/, '');

      // Convert base64 to buffer
      const buffer = Buffer.from(base64Content, 'base64');

      // Generate filename if not provided
      const finalFileName = fileName || `upload-${Date.now()}.bin`;
      const filePath = path.join(this.tempDir, finalFileName);

      // Save to file
      fs.writeFileSync(filePath, buffer);

      return {
        success: true,
        filePath: filePath,
        fileName: finalFileName,
        size: buffer.length,
      };
    } catch (error) {
      throw new Error(`Failed to save base64 file: ${error}`, { cause: error });
    }
  }

  /**
   * Verify that a file exists and is accessible
   */
  private async verifyFile(filePath: string): Promise<any> {
    try {
      // Check if file exists
      if (!fs.existsSync(filePath)) {
        throw new Error(`File does not exist: ${filePath}`);
      }

      // Get file stats
      const stats = fs.statSync(filePath);

      // Check if it's actually a file
      if (!stats.isFile()) {
        throw new Error(`Path is not a file: ${filePath}`);
      }

      // Check if file is readable
      fs.accessSync(filePath, fs.constants.R_OK);

      return {
        success: true,
        filePath: filePath,
        fileName: path.basename(filePath),
        size: stats.size,
      };
    } catch (error) {
      throw new Error(`Failed to verify file: ${error}`, { cause: error });
    }
  }

  /**
   * Read file content and return as base64 string
   */
  private async readBase64File(filePath: string): Promise<any> {
    try {
      // Path traversal guard: only files inside our temp dir are readable.
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(this.tempDir + path.sep) && resolved !== this.tempDir) {
        throw new Error('readBase64File only allowed inside the bridge temp directory');
      }
      if (!fs.existsSync(resolved)) {
        throw new Error(`File does not exist: ${resolved}`);
      }
      const stats = fs.statSync(resolved);
      if (!stats.isFile()) {
        throw new Error(`Path is not a file: ${resolved}`);
      }
      if (stats.size > MAX_DOWNLOAD_BYTES) {
        throw new Error(`File too large to read: ${stats.size} bytes`);
      }
      const buf = fs.readFileSync(resolved);
      const base64 = buf.toString('base64');
      return {
        success: true,
        filePath: resolved,
        fileName: path.basename(resolved),
        size: stats.size,
        base64Data: base64,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Clean up a temporary file
   */
  private async cleanupFile(filePath: string): Promise<any> {
    try {
      // Only allow cleanup of files in our temp directory
      if (!filePath.startsWith(this.tempDir)) {
        return {
          success: false,
          error: 'Can only cleanup files in temp directory',
        };
      }

      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      return {
        success: true,
        message: 'File cleaned up successfully',
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to cleanup file: ${error}`,
      };
    }
  }

  /**
   * Generate a filename from URL or create a unique one
   */
  private generateFileName(url?: string): string {
    if (url) {
      try {
        const urlObj = new URL(url);
        const pathname = urlObj.pathname;
        const basename = path.basename(pathname);
        if (basename && basename !== '/') {
          // Add random suffix to avoid collisions
          const ext = path.extname(basename);
          const name = path.basename(basename, ext);
          const randomSuffix = crypto.randomBytes(4).toString('hex');
          return `${name}-${randomSuffix}${ext}`;
        }
      } catch {
        // Invalid URL, fall through to generate random name
      }
    }

    // Generate random filename
    return `upload-${crypto.randomBytes(8).toString('hex')}.bin`;
  }

  /**
   * Clean up old temporary files (older than 1 hour)
   */
  cleanupOldFiles(): void {
    try {
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;

      const files = fs.readdirSync(this.tempDir);
      for (const file of files) {
        const filePath = path.join(this.tempDir, file);
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > oneHour) {
          fs.unlinkSync(filePath);
          log.info({ file }, 'cleaned up old temp file');
        }
      }
    } catch (error) {
      log.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'error cleaning up old files',
      );
    }
  }
}

export default new FileHandler();
