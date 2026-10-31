/** Offline local owner command. Metadata on stdin; raw master key on FD 3, optional import on FD 4. */
import { fstatSync, readSync } from 'node:fs';
import { createAppContext } from '@memebots/config';
import { createPool } from '../pool.js';
import {
  getWalletView,
  inspectVault,
  provisionBotWallet,
  recordWalletBalance,
  setWalletCap,
} from './accounts.js';
import { readWalletBalance } from './balance.js';
import { prepareWallet } from './prepare.js';
import { createOfflineVault } from './vault.js';
import { fail, WalletError } from './validation.js';

function input(fd: number, max: number): Buffer {
  const stat = fstatSync(fd);
  if (stat.isFile() && (stat.mode & 0o077) !== 0) fail('INPUT_PERMISSIONS');
  const out = Buffer.alloc(max + 1);
  let length = 0;
  try {
    while (length <= max) {
      const n = readSync(fd, out, length, max + 1 - length, null);
      if (n === 0) break;
      length += n;
    }
    if (length > max) fail('INPUT_TOO_LARGE');
    return Buffer.from(out.subarray(0, length));
  } finally {
    out.fill(0);
  }
}
function string(value: unknown): string {
  if (typeof value !== 'string') fail('INVALID_INPUT');
  return value;
}
function amount(value: unknown): bigint {
  const s = string(value);
  if (!/^(0|[1-9][0-9]{0,38})$/.test(s)) fail('INVALID_AMOUNT');
  return BigInt(s);
}
let key: Buffer | undefined, imported: Buffer | undefined;
const context = createAppContext(process.env, (line) => process.stderr.write(`${line}\n`));
if (!context) {
  process.exitCode = 1;
} else {
  const pool = createPool(context.config.databaseUrl.reveal());
  try {
    const raw = input(0, 16_384);
    let request: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw.toString('utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        fail('INVALID_INPUT');
      request = parsed as Record<string, unknown>;
    } finally {
      raw.fill(0);
    }
    const command = process.argv[2];
    let result: unknown;
    if (command === 'view' || command === 'refresh') {
      const botId = string(request.botId);
      if (command === 'refresh') {
        const prior = await getWalletView(pool, botId);
        const snapshot = await readWalletBalance(context.config.discovery.rpcUrl, prior.publicKey);
        await recordWalletBalance(pool, botId, snapshot.balanceLamports, snapshot.observedAt);
      }
      result = await getWalletView(pool, botId);
    } else if (command === 'cap') {
      await setWalletCap(pool, string(request.botId), amount(request.spendCapLamports));
      result = { status: 'updated' };
    } else if (command === 'inspect') {
      result = await inspectVault(pool, await createOfflineVault(string(request.vaultDirectory)));
    } else if (command === 'prepare') {
      key = input(3, 32);
      if (key.length !== 32) fail('INVALID_KEY');
      if (
        Object.keys(request).some(
          (k) => !['walletId', 'label', 'spendCapLamports', 'vaultDirectory'].includes(k),
        )
      )
        fail('INVALID_INPUT');
      result = await prepareWallet(pool, {
        walletId: string(request.walletId),
        label: string(request.label),
        spendCapLamports: amount(request.spendCapLamports),
        vault: await createOfflineVault(string(request.vaultDirectory)),
        encryptionKey: key,
      });
    } else if (command === 'provision' || command === 'create') {
      key = input(3, 32);
      if (key.length !== 32) fail('INVALID_KEY');
      if (request.import === true) imported = input(4, 1024);
      if (request.import !== undefined && typeof request.import !== 'boolean')
        fail('INVALID_INPUT');
      const vault = await createOfflineVault(string(request.vaultDirectory));
      const bot =
        command === 'provision'
          ? { id: string(request.botId) }
          : {
              name: string(request.name),
              strategy: string(request.strategy),
              riskProfileId: string(request.riskProfileId),
              paperBankrollLamports: amount(request.paperBankrollLamports),
            };
      result = await provisionBotWallet(pool, {
        bot,
        label: string(request.label),
        spendCapLamports: amount(request.spendCapLamports),
        vault,
        encryptionKey: key,
        ...(imported ? { imported } : {}),
      });
    } else fail('INVALID_COMMAND');
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    // A provider/DB/filesystem exception can contain sensitive inputs. Never log raw exceptions here.
    context.logger.error('wallet_command_failed', {
      code: error instanceof WalletError ? error.code : 'WALLET_COMMAND_FAILED',
    });
    process.exitCode = 1;
  } finally {
    key?.fill(0);
    imported?.fill(0);
    await pool.end();
  }
}
