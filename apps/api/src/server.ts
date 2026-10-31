import { registerControl } from './control.js';
import type { LocalControlOptions } from './control.js';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { BotMode } from '@memebots/core';
import type { AppLogger } from '@memebots/config';

export interface HealthResponse {
  readonly status: 'ok';
  readonly mode: BotMode;
  readonly liveTradingAvailable: boolean;
}

export interface ServerOptions {
  readonly mode: BotMode;
  readonly logger?: AppLogger;
  readonly control?: LocalControlOptions;
}

export function buildServer({ mode, logger, control }: ServerOptions): FastifyInstance {
  // Disable Fastify/Pino's raw request/error sink; all application output uses the shared logger.
  const app = Fastify({ logger: false, bodyLimit: 16_384 });

  app.addHook('onResponse', async (request, reply) => {
    logger?.info('http_response', { method: request.method, statusCode: reply.statusCode });
  });
  app.setErrorHandler((error, _request, reply) => {
    logger?.error('http_request_failed', { error });
    // Do not reflect a provider/database exception (which could contain credentials) to the client.
    let status = 500;
    try {
      const code: unknown =
        typeof error === 'object' && error !== null
          ? Object.getOwnPropertyDescriptor(error, 'statusCode')?.value
          : undefined;
      if (typeof code === 'number' && Number.isInteger(code) && code >= 400 && code < 500)
        status = code;
    } catch {
      // A thrown proxy/accessor must not create a second, unredacted error path.
    }
    void reply
      .code(status)
      .send({ error: status === 500 ? 'Internal server error' : 'Request failed' });
  });

  app.get('/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    mode,
    // Turns true only once the live executor and kill switch exist (BOT-15, BOT-17).
    liveTradingAvailable: false,
  }));

  if (control) registerControl(app, control);
  return app;
}
