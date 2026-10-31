/** Offline provisioning only. No persisted-key reader, signing or send API. */
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, link, unlink, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { decryptSecret, encryptSecret } from '@memebots/config';
import { fail, uuid } from './validation.js';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(bytes: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)]! + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

/** Strict import: a JSON array of exactly 64 integer bytes: seed followed by public key. */
function secretBytes(input?: Uint8Array): { bytes: Buffer; publicKey: string } {
  let seed: Buffer | undefined;
  let bytes: Buffer | undefined;
  try {
    if (input !== undefined && (!(input instanceof Uint8Array) || input.length > 1024))
      fail('INVALID_IMPORT');
    if (input === undefined) {
      const key = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
      seed = Buffer.from(key.d!, 'base64url');
    } else {
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input));
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 64 ||
        parsed.some(
          (b: unknown) => typeof b !== 'number' || !Number.isInteger(b) || b < 0 || b > 255,
        )
      )
        fail('INVALID_IMPORT');
      bytes = Buffer.from(parsed);
      seed = Buffer.from(bytes.subarray(0, 32));
    }
    const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
    let publicBytes: Buffer;
    try {
      const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
      publicBytes = Buffer.from(
        createPublicKey(privateKey).export({ format: 'jwk' }).x!,
        'base64url',
      );
    } finally {
      der.fill(0);
    }
    if (bytes && !publicBytes.equals(bytes.subarray(32))) fail('INVALID_IMPORT');
    return { bytes: Buffer.concat([seed, publicBytes]), publicKey: base58(publicBytes) };
  } catch {
    return fail('INVALID_IMPORT');
  } finally {
    seed?.fill(0);
    bytes?.fill(0);
  }
}

export interface OfflineVault {
  /** Writes encrypted material durably before returning public metadata. */
  provision(walletId: string, encryptionKey: Uint8Array, imported?: Uint8Array): Promise<string>;
  publicKey(walletId: string, encryptionKey: Uint8Array): Promise<string>;
  removeUncommitted(walletId: string): Promise<void>;
  listIds(): Promise<string[]>;
}

/** Require a private, local, non-repository directory with no symlink components. */
async function safeDirectory(path: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path) fail('VAULT_UNAVAILABLE');
  let current = parse(path).root;
  for (const part of path.slice(current.length).split('/')) {
    current = join(current, part);
    try {
      const entry = await lstat(current);
      if (!entry.isDirectory() || entry.isSymbolicLink()) fail('VAULT_UNAVAILABLE');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || current !== path) throw error;
      await mkdir(current, { mode: 0o700 });
      const parent = await open(
        dirname(current),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
    try {
      await lstat(join(current, '.git'));
      fail('VAULT_UNAVAILABLE');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const stat = await lstat(path);
  if (
    (stat.mode & 0o777) !== 0o700 ||
    stat.uid !== process.getuid?.() ||
    (await realpath(path)) !== path
  )
    fail('VAULT_UNAVAILABLE');
  return path;
}

export async function createOfflineVault(directory: string): Promise<OfflineVault> {
  let root: string;
  try {
    root = await safeDirectory(directory);
  } catch {
    return fail('VAULT_UNAVAILABLE');
  }
  const file = (id: string) => join(root, `${uuid(id)}.vault.json`);
  const syncDirectory = async () => {
    const fd = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
  };
  return {
    async provision(walletId, encryptionKey, imported) {
      let material: ReturnType<typeof secretBytes> | undefined;
      const target = file(walletId);
      const temporary = join(root, `.${randomUUID()}.tmp`);
      let linked = false;
      try {
        await safeDirectory(root);
        if (!(encryptionKey instanceof Uint8Array) || encryptionKey.length !== 32)
          fail('INVALID_KEY');
        material = secretBytes(imported);
        const envelope = encryptSecret(
          JSON.stringify({ walletId, keypair: material.bytes.toString('base64') }),
          encryptionKey,
        );
        const fd = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await fd.writeFile(envelope, 'utf8');
          await fd.sync();
        } finally {
          await fd.close();
        }
        await link(temporary, target);
        linked = true;
        await unlink(temporary);
        await syncDirectory();
        return material.publicKey;
      } catch {
        if (linked) await unlink(target).catch(() => {});
        return fail('PROVISION_FAILED');
      } finally {
        material?.bytes.fill(0);
        await unlink(temporary).catch(() => {});
      }
    },
    async publicKey(id, encryptionKey) {
      let raw: Buffer | undefined;
      let material: ReturnType<typeof secretBytes> | undefined;
      try {
        await safeDirectory(root);
        const fd = await open(file(id), constants.O_RDONLY | constants.O_NOFOLLOW);
        let envelope: string;
        try {
          const stat = await fd.stat();
          if (
            !stat.isFile() ||
            (stat.mode & 0o777) !== 0o600 ||
            stat.uid !== process.getuid?.() ||
            stat.size > 16384
          )
            fail('VAULT_UNAVAILABLE');
          envelope = await fd.readFile('utf8');
        } finally {
          await fd.close();
        }
        const value = JSON.parse(decryptSecret(envelope, encryptionKey)) as {
          walletId?: unknown;
          keypair?: unknown;
        };
        if (value.walletId !== id || typeof value.keypair !== 'string') fail('VAULT_UNAVAILABLE');
        raw = Buffer.from(value.keypair, 'base64');
        material = secretBytes(Buffer.from(JSON.stringify([...raw])));
        return material.publicKey;
      } catch {
        return fail('VAULT_UNAVAILABLE');
      } finally {
        raw?.fill(0);
        material?.bytes.fill(0);
      }
    },
    async removeUncommitted(id) {
      try {
        await safeDirectory(root);
        await unlink(file(id));
        await syncDirectory();
      } catch {
        fail('VAULT_CLEANUP_REQUIRED');
      }
    },
    async listIds() {
      try {
        await safeDirectory(root);
        const ids: string[] = [];
        for (const name of await readdir(root)) {
          if (!/^[0-9a-f-]{36}\.vault\.json$/.test(name)) continue;
          const stat = await lstat(join(root, name));
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            (stat.mode & 0o777) !== 0o600 ||
            stat.uid !== process.getuid?.()
          )
            fail('VAULT_UNAVAILABLE');
          ids.push(uuid(name.slice(0, 36)));
        }
        return ids;
      } catch {
        return fail('VAULT_UNAVAILABLE');
      }
    },
  };
}
