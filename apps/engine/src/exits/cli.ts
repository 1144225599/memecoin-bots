import { setTimeout as delay } from 'node:timers/promises';
import { createLogger, loadConfig, SecretRegistry } from '@memebots/config';
import { createPool, inspectPositionExit, reservePaperQuoteRequest } from '@memebots/db';
import type { Pool } from '@memebots/db';
import { JupiterReadOnlyQuoteProvider } from '../paper/quote.js';
import { PositionExitManager } from './manager.js';
const registry = new SecretRegistry();
const logger = createLogger(registry, (line) => process.stdout.write(`${line}\n`));
const controller = new AbortController();
const stop = () => controller.abort();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
let pool: Pool | undefined;
try {
  const config = loadConfig(process.env, registry);
  pool = createPool(config.databaseUrl.reveal(), { max: 2 });
  const [command, id] = process.argv.slice(2);
  if (command === 'inspect') {
    if (!id) throw new Error('POSITION_ID_REQUIRED');
    logger.info('exit_inspect', { positionId: id, exit: await inspectPositionExit(pool, id) });
  } else if (command === 'once' || command === 'watch') {
    const provider = new JupiterReadOnlyQuoteProvider({
      budget: {
        take: async () => {
          try {
            await reservePaperQuoteRequest(pool!);
          } catch (error) {
            if (!(error instanceof Error) || error.message !== 'QUOTE_RATE_LIMIT') throw error;
            // Two amount-specific requests (mark then execution) must respect the shared 2s cadence.
            await delay(2100, undefined, { signal: controller.signal });
            await reservePaperQuoteRequest(pool!);
          }
        },
      },
      ...(config.providers.jupiterApiKey ? { apiKey: config.providers.jupiterApiKey } : {}),
      ...(process.env.PAPER_QUOTE_MOCK_URL
        ? { localMockUrl: process.env.PAPER_QUOTE_MOCK_URL }
        : {}),
    });
    const manager = new PositionExitManager(pool, provider, { signal: controller.signal });
    do {
      for (const outcome of await manager.once(id ? { botId: id } : {}))
        logger.info('exit_progress', { ...outcome });
      if (command === 'once') break;
      await delay(2500, undefined, { signal: controller.signal });
    } while (!controller.signal.aborted);
  } else throw new Error('USAGE: exit once/watch [botId] | exit inspect positionId');
} catch {
  if (!controller.signal.aborted) {
    logger.error('exit_command_failed', { code: 'EXIT_COMMAND_FAILED' });
    process.exitCode = 1;
  }
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  await pool?.end();
}
