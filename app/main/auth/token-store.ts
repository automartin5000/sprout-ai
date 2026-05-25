import { app, safeStorage } from 'electron';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number;
}

/**
 * Refresh tokens live encrypted on disk under userData via Electron
 * safeStorage. We avoid keytar so we don't need to ship a native module
 * through electron-builder's notarization pass.
 */
export class TokenStore {
  private readonly file: string;

  constructor(opts: { file?: string } = {}) {
    this.file = opts.file
      ?? path.join(app.getPath('userData'), 'auth.bin');
  }

  async load(): Promise<StoredTokens | undefined> {
    const raw = await fs.readFile(this.file).catch(() => undefined);
    if (!raw) return undefined;
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('safeStorage encryption is not available on this platform');
    }
    const json = safeStorage.decryptString(raw);
    return JSON.parse(json) as StoredTokens;
  }

  async save(tokens: StoredTokens): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('safeStorage encryption is not available on this platform');
    }
    const encrypted = safeStorage.encryptString(JSON.stringify(tokens));
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, encrypted);
  }

  async clear(): Promise<void> {
    await fs.rm(this.file, { force: true });
  }
}
