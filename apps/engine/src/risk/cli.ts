import { readFile, stat } from 'node:fs/promises';
import { createAppContext } from '@memebots/config';
import type { OpportunityTarget, PaperModel, RiskLiquidity } from '@memebots/core';
import {
  createPool,
  loadPaperIntent,
  reconcileRiskAdmissions,
  reservePaperQuoteRequest,
  SafetyStore,
  setPaperRiskCap,
} from '@memebots/db';
import { JupiterReadOnlyQuoteProvider } from '../paper/quote.js';
import { validateEvidence } from '../safety/evidence.js';
import { RiskManager, createRiskPaperBroker } from './manager.js';

const context = createAppContext(process.env, (line) => process.stderr.write(`${line}\n`));
if (!context) process.exitCode = 1;
else {
  const pool = createPool(context.config.databaseUrl.reveal(), { max: 2 });
  try {
    const [command, path, value] = process.argv.slice(2);
    if (command === 'cap' && path && value) {
      await setPaperRiskCap(pool, path, value);
      process.stdout.write('Paper cap saved\n');
    } else if (command === 'reconcile' && path) {
      await reconcileRiskAdmissions(pool, path);
      process.stdout.write('Pending admissions reconciled\n');
    } else if (
      (command === 'submit' || command === 'owner-scenario' || command === 'process') &&
      path
    ) {
      if ((await stat(path)).size > 32768) throw new Error('INPUT_TOO_LARGE');
      const input = JSON.parse(await readFile(path, 'utf8')) as {
        botId: string;
        strategy: string;
        key: string;
        signal: unknown;
        target: OpportunityTarget;
        liquidity: RiskLiquidity;
        model: PaperModel;
        safetyEvidence?: unknown;
        orderId?: string;
      };
      const provider = new JupiterReadOnlyQuoteProvider({
        budget: { take: () => reservePaperQuoteRequest(pool) },
        ...(context.config.providers.jupiterApiKey
          ? { apiKey: context.config.providers.jupiterApiKey }
          : {}),
      });
      const owner = command === 'owner-scenario';
      if (owner && input.safetyEvidence) {
        const evidence = validateEvidence(input.safetyEvidence),
          store = new SafetyStore(pool),
          key = `solana:${evidence.mint}:none`,
          lease = await store.acquire(key);
        if (!lease) throw new Error('SAFETY_REFRESH_BUSY');
        await store.save({
          key,
          mint: evidence.mint,
          evidence,
          expiresAt: new Date(
            Math.min(...Object.values(evidence.checks).map((c) => Date.parse(c.expiresAt))),
          ).toISOString(),
          refreshMs: 10000,
          lease,
        });
        if (evidence.decimals !== null)
          await pool.query(
            'INSERT INTO tokens(mint,decimals) VALUES($1,$2) ON CONFLICT DO NOTHING',
            [evidence.mint, evidence.decimals],
          );
      }
      const manager = new RiskManager(pool, provider, input.model, {
        ownerPaperScenario: owner,
        liquidity: async () => input.liquidity ?? null,
      });
      const decision =
        command === 'process' && input.orderId
          ? { status: 'approved' as const, intent: await loadPaperIntent(pool, input.orderId) }
          : await manager.submitSignal(
              input.botId,
              input.strategy,
              input.signal,
              input.key,
              input.target,
            );
      process.stdout.write(
        `${JSON.stringify({ evidenceMode: owner ? 'OWNER_PAPER_SCENARIO' : 'PRODUCTION', decision })}\n`,
      );
      if (decision.status === 'approved') {
        const result = await createRiskPaperBroker(pool, provider, input.model).execute(
          decision.intent,
          `${input.key}:execution`,
        );
        process.stdout.write(`${JSON.stringify(result)}\n`);
      }
    } else throw new Error('USAGE');
  } catch {
    context.logger.error('risk_command_failed', { code: 'RISK_COMMAND_FAILED_NO_LIVE_EXECUTION' });
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
