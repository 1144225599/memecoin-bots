import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  BotControlError,
  botControlSnapshot,
  createControlledBot,
  getControlledBot,
  listPreparedWallets,
  listControlProfiles,
  transitionControlledBot,
  updateControlledBot,
} from '@memebots/db';
import type { Pool } from '@memebots/db';

export interface LocalControlOptions {
  readonly pool: Pool;
  readonly apiPort?: number;
  readonly dashboardOrigin?: string;
}
/** Loopback owner/browser-session boundary, not authentication against a hostile local OS user. */
export function registerControl(app: FastifyInstance, options: LocalControlOptions): void {
  const dashboardOrigin = options.dashboardOrigin ?? 'http://127.0.0.1:5173';
  const apiOrigin = `http://127.0.0.1:${options.apiPort ?? 3001}`;
  const origins = new Set([dashboardOrigin, apiOrigin]);
  const hosts = new Set([...origins].map((o) => new URL(o).host));
  const sessions = new Map<string, { token: string; expires: number }>();
  const cookieName = 'memebots_local_session';
  app.register(async (routes) => {
    routes.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
      const origin = request.headers.origin,
        site = request.headers['sec-fetch-site'];
      if (
        !hosts.has(request.headers.host ?? '') ||
        (origin !== undefined && !origins.has(origin)) ||
        (site !== undefined && site !== 'same-origin') ||
        (origin === undefined && site !== 'same-origin')
      ) {
        await reply.code(403).send({ code: 'LOCAL_ORIGIN_REQUIRED' });
        return;
      }
      if (request.url.split('?')[0] === '/control/session' && request.method === 'GET') return;
      const cookie = request.headers.cookie
        ?.split(';')
        .map((x) => x.trim())
        .find((x) => x.startsWith(`${cookieName}=`))
        ?.slice(cookieName.length + 1);
      const session = cookie ? sessions.get(cookie) : undefined;
      if (!session || session.expires <= Date.now()) {
        await reply.code(403).send({ code: 'LOCAL_SESSION_REQUIRED' });
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        const token = request.headers['x-local-csrf'];
        if (
          origin === undefined ||
          request.headers['content-type']?.split(';')[0] !== 'application/json' ||
          typeof token !== 'string' ||
          !/^[a-f0-9]{64}$/.test(token) ||
          !timingSafeEqual(Buffer.from(token), Buffer.from(session.token))
        ) {
          await reply.code(403).send({ code: 'CSRF_REJECTED' });
          return;
        }
      }
    });
    routes.setNotFoundHandler((_request, reply) =>
      reply.code(404).send({ code: 'CONTROL_NOT_FOUND' }),
    );
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof BotControlError) {
        void reply.code(error.status).send({ code: error.code });
        return;
      }
      const status =
        typeof error === 'object' &&
        error !== null &&
        'statusCode' in error &&
        typeof error.statusCode === 'number' &&
        error.statusCode >= 400 &&
        error.statusCode < 500
          ? error.statusCode
          : 500;
      void reply
        .code(status)
        .send({ code: status === 500 ? 'CONTROL_UNAVAILABLE' : 'INVALID_REQUEST' });
    });
    routes.get('/control/session', async (request, reply) => {
      const existingId = request.headers.cookie
        ?.split(';')
        .map((x) => x.trim())
        .find((x) => x.startsWith(`${cookieName}=`))
        ?.slice(cookieName.length + 1);
      const existing = existingId ? sessions.get(existingId) : undefined;
      // Same local browser session across tabs: opening a second panel must not invalidate the first tab's token.
      if (existing && existing.expires > Date.now())
        return { csrfToken: existing.token, liveTradingAvailable: false };
      for (const [key, value] of sessions) if (value.expires <= Date.now()) sessions.delete(key);
      if (sessions.size >= 64) sessions.delete(sessions.keys().next().value!);
      const id = randomBytes(32).toString('hex'),
        token = randomBytes(32).toString('hex');
      sessions.set(id, { token, expires: Date.now() + 60 * 60_000 });
      reply.header('Set-Cookie', `${cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/`);
      return { csrfToken: token, liveTradingAvailable: false };
    });
    routes.get('/control', async () => botControlSnapshot(options.pool));
    routes.get('/control/profiles', async () => listControlProfiles(options.pool));
    routes.get('/control/wallets', async () => listPreparedWallets(options.pool));
    routes.get<{ Params: { id: string } }>('/control/bots/:id', async (request) =>
      getControlledBot(options.pool, request.params.id),
    );
    routes.post('/control/bots', async (request, reply) => {
      const bot = await createControlledBot(options.pool, request.body);
      return reply.code(201).send(bot);
    });
    routes.put<{ Params: { id: string } }>('/control/bots/:id', async (request) =>
      updateControlledBot(options.pool, request.params.id, request.body),
    );
    routes.post<{ Params: { id: string } }>('/control/bots/:id/mode', async (request) =>
      transitionControlledBot(options.pool, request.params.id, request.body),
    );
  });
}
