/** Disposable local QA only: real offline encrypted wallets, no signing/funding. */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppContext } from '../packages/config/src/index.js';
import { createPool, migrateUp } from '../packages/db/src/index.js';
import { createOfflineVault } from '../packages/db/src/wallet-management/vault.js';
import { prepareWallet } from '../packages/db/src/wallet-management/prepare.js';
const context = createAppContext(process.env, (line) => process.stderr.write(`${line}\n`));
if (!context) process.exitCode = 1;
else {
  const url = context.config.databaseUrl.reveal();
  if (!new URL(url).pathname.endsWith('_preview_test'))
    throw new Error('DISPOSABLE_PREVIEW_DATABASE_REQUIRED');
  const pool = createPool(url),
    key = randomBytes(32);
  try {
    await migrateUp(pool);
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'bot-control-preview-')));
    const vault = await createOfflineVault(join(dir, 'vault'));
    for (let i = 1; i <= 3; i++)
      await prepareWallet(pool, {
        walletId: randomUUID(),
        label: `Disposable preview ${i}`,
        spendCapLamports: 2_000_000_000n,
        vault,
        encryptionKey: key,
      });
    // Only a cleanup location, public metadata and counts; never key material.
    process.stdout.write(
      `${JSON.stringify({ status: 'prepared', wallets: 3, temporaryDirectory: dir, cleanup: 'Remove this temporary directory after QA; these wallets must never receive funds.' })}\n`,
    );
  } finally {
    key.fill(0);
    await pool.end();
  }
}
