import { SecretRegistry } from './secrets.js';
import type { Secret } from './secrets.js';
import { decryptSecret } from './vault.js';

export type Environment = Readonly<Record<string, string | undefined>>;
export interface AppConfig {
  readonly mode: 'paper';
  readonly marketData: 'fixtures' | 'mainnet';
  readonly databaseUrl: Secret;
  readonly discovery: Readonly<{ enabled: boolean; rpcUrl: Secret; wsUrl: Secret }>;
  readonly dashboardOrigin: string;
  readonly api: Readonly<{ host: '127.0.0.1'; port: number }>;
  readonly providers: Readonly<{
    heliusRpcUrl?: Secret;
    jupiterApiKey?: Secret;
    jupiterBaseUrl: 'https://api.jup.ag';
    dexScreenerBaseUrl: 'https://api.dexscreener.com';
  }>;
  readonly limits: Readonly<{
    monthlyServiceBudgetUsd: 0;
    heliusMonthlyCreditStop: number;
    jupiterRequestsPerMinute: number;
    watchlistSize: number;
    snapshotIntervalMs: number;
    maxDataAgeMs: number;
  }>;
}

const CONFIG_KEYS = new Set([
  'BOT_MODE',
  'BOT_MARKET_DATA',
  'MARKET_DATA_ENABLED',
  'SOLANA_RPC_URL',
  'SOLANA_WS_URL',
  'DATABASE_URL',
  'API_PORT',
  'API_HOST',
  'API_DASHBOARD_ORIGIN',
  'HELIUS_API_KEY',
  'JUPITER_API_KEY',
  'BOT_MONTHLY_SERVICE_BUDGET_USD',
  'BOT_HELIUS_MONTHLY_CREDIT_STOP',
  'BOT_JUPITER_REQUESTS_PER_MINUTE',
  'BOT_WATCHLIST_SIZE',
  'BOT_SNAPSHOT_INTERVAL_MS',
  'BOT_MAX_DATA_AGE_MS',
  'BOT_ENCRYPTED_CONFIG',
  'BOT_CONFIG_ENCRYPTION_KEY',
]);
const SIGNING_KEY = /(?:privatekey|secretkey|seedphrase|mnemonic|keypair|walletsecret)/i;
const SIGNING_FLAG = /(?:livetrading|enablelive|liveenabled|enablesigning)/i;
const MAX_ENV_VALUE = 16_384;

/** Field names are fixed identifiers only. Raw input is never put in errors. */
export class ConfigurationError extends Error {
  readonly code = 'INVALID_CONFIGURATION';
  readonly fields: readonly string[];
  constructor(fields: readonly string[]) {
    const reserved = new Set([
      'ENVIRONMENT',
      'SIGNING_CONFIGURATION_NOT_ALLOWED',
      'UNKNOWN_BOT_SETTING',
    ]);
    const safe = [
      ...new Set(
        fields.map((field) =>
          CONFIG_KEYS.has(field) || reserved.has(field) ? field : 'ENVIRONMENT',
        ),
      ),
    ].sort();
    super(
      `Invalid or missing configuration: ${safe.join(', ')}. Check the configuration reference.`,
    );
    this.name = 'ConfigurationError';
    this.fields = Object.freeze(safe);
  }
}

function fail(field: string): never {
  throw new ConfigurationError([field]);
}

/** Read only own data properties; never execute environment getters. */
function snapshot(env: Environment): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = Object.create(null);
  try {
    for (const key of Object.getOwnPropertyNames(env)) {
      const normalized = key.replace(/[^a-zA-Z0-9]/g, '');
      const descriptor = Object.getOwnPropertyDescriptor(env, key);
      if (!descriptor || !('value' in descriptor)) {
        if (CONFIG_KEYS.has(key) || key.startsWith('BOT_') || SIGNING_KEY.test(normalized))
          fail('ENVIRONMENT');
        continue;
      }
      const value: unknown = descriptor.value;
      if (
        (SIGNING_KEY.test(normalized) || SIGNING_FLAG.test(normalized)) &&
        value !== undefined &&
        value !== ''
      ) {
        fail('SIGNING_CONFIGURATION_NOT_ALLOWED');
      }
      if (key.startsWith('BOT_') && !CONFIG_KEYS.has(key)) fail('UNKNOWN_BOT_SETTING');
      if (!CONFIG_KEYS.has(key)) continue;
      const maxLength = key === 'BOT_ENCRYPTED_CONFIG' ? 88_000 : MAX_ENV_VALUE;
      if (value !== undefined && (typeof value !== 'string' || value.length > maxLength)) fail(key);
      out[key] = value as string | undefined;
    }
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    fail('ENVIRONMENT');
  }
  return out;
}

/** Encrypted values supplement, never silently override, the environment. */
function resolveEncryptedSecrets(
  env: Record<string, string | undefined>,
  registry: SecretRegistry,
): void {
  const envelope = env.BOT_ENCRYPTED_CONFIG;
  const encodedKey = env.BOT_CONFIG_ENCRYPTION_KEY;
  if (envelope === undefined && encodedKey === undefined) return;
  if (!envelope) fail('BOT_ENCRYPTED_CONFIG');
  if (!encodedKey) fail('BOT_CONFIG_ENCRYPTION_KEY');
  const key = Buffer.from(encodedKey, 'base64');
  try {
    if (key.length !== 32 || key.toString('base64') !== encodedKey)
      fail('BOT_CONFIG_ENCRYPTION_KEY');
    registry.register(encodedKey);
    registry.register(envelope);
    const plaintext = decryptSecret(envelope, key);
    registry.register(plaintext);
    const values: unknown = JSON.parse(plaintext);
    if (values === null || typeof values !== 'object' || Array.isArray(values))
      fail('BOT_ENCRYPTED_CONFIG');
    const allowed = new Set([
      'DATABASE_URL',
      'HELIUS_API_KEY',
      'JUPITER_API_KEY',
      'SOLANA_RPC_URL',
      'SOLANA_WS_URL',
    ]);
    for (const [name, value] of Object.entries(values)) {
      if (!allowed.has(name) || typeof value !== 'string' || value.length > MAX_ENV_VALUE)
        fail('BOT_ENCRYPTED_CONFIG');
      if (env[name] !== undefined) fail(name);
      env[name] = value;
    }
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    fail('BOT_ENCRYPTED_CONFIG');
  } finally {
    key.fill(0);
  }
}

function hasControls(value: string): boolean {
  return Array.from(value).some(
    (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
  );
}

function integer(
  env: Environment,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) fail(key);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(key);
  return value;
}

function credential(env: Environment, key: string): string | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  if (value.length === 0 || value.trim() !== value || hasControls(value)) fail(key);
  try {
    encodeURIComponent(value);
  } catch {
    return fail(key);
  }
  return value;
}

function database(value: string | undefined, registry: SecretRegistry): Secret {
  if (!value || value.trim() !== value) fail('DATABASE_URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail('DATABASE_URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname.length < 2 ||
    url.hash ||
    url.search ||
    hasControls(value)
  )
    fail('DATABASE_URL');
  // Do not allow query parameters to override the validated loopback host.
  try {
    if (url.username) registry.register(decodeURIComponent(url.username));
    if (url.password) registry.register(decodeURIComponent(url.password));
  } catch {
    return fail('DATABASE_URL');
  }
  return registry.register(value);
}

/** Keep endpoint credentials wrapped until the read-only provider boundary. */
function endpoint(
  value: string,
  field: string,
  protocols: readonly string[],
  registry: SecretRegistry,
): Secret {
  if (value.trim() !== value || hasControls(value)) fail(field);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail(field);
  }
  if (!protocols.includes(url.protocol) || !url.hostname || url.hash) fail(field);
  try {
    if (url.username) registry.register(decodeURIComponent(url.username));
    if (url.password) registry.register(decodeURIComponent(url.password));
    // Query values can contain provider tokens even with nonstandard parameter names.
    for (const token of url.searchParams.values()) if (token) registry.register(token);
    registry.register(value);
    return registry.register(url.href);
  } catch {
    return fail(field);
  }
}

/** Validates a supplied environment/secret-manager mapping. Never reads files or makes requests. */
export function loadConfig(input: Environment, registry = new SecretRegistry()): AppConfig {
  const env = snapshot(input);
  resolveEncryptedSecrets(env, registry);
  const mode = env.BOT_MODE ?? 'paper';
  if (mode !== 'paper') fail('BOT_MODE');
  const marketData = env.BOT_MARKET_DATA ?? 'fixtures';
  if (marketData !== 'fixtures' && marketData !== 'mainnet') fail('BOT_MARKET_DATA');
  if (env.API_HOST !== undefined && env.API_HOST !== '127.0.0.1') fail('API_HOST');
  const dashboardOrigin = env.API_DASHBOARD_ORIGIN ?? 'http://127.0.0.1:5173';
  try {
    const parsed = new URL(dashboardOrigin);
    if (
      parsed.protocol !== 'http:' ||
      parsed.hostname !== '127.0.0.1' ||
      parsed.origin !== dashboardOrigin ||
      !parsed.port
    )
      fail('API_DASHBOARD_ORIGIN');
  } catch {
    fail('API_DASHBOARD_ORIGIN');
  }
  const budget = integer(env, 'BOT_MONTHLY_SERVICE_BUDGET_USD', 0, 0, 0);
  const heliusKey = credential(env, 'HELIUS_API_KEY');
  const jupiterKey = credential(env, 'JUPITER_API_KEY');
  if (marketData === 'mainnet' && !heliusKey) fail('HELIUS_API_KEY');

  const enabled = env.MARKET_DATA_ENABLED ?? 'false';
  if (enabled !== 'true' && enabled !== 'false') fail('MARKET_DATA_ENABLED');
  const discovery = Object.freeze({
    enabled: enabled === 'true',
    rpcUrl: endpoint(
      env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com',
      'SOLANA_RPC_URL',
      ['http:', 'https:'],
      registry,
    ),
    wsUrl: endpoint(
      env.SOLANA_WS_URL ?? 'wss://api.mainnet-beta.solana.com',
      'SOLANA_WS_URL',
      ['ws:', 'wss:'],
      registry,
    ),
  });
  const db = database(env.DATABASE_URL, registry);
  const providers: {
    heliusRpcUrl?: Secret;
    jupiterApiKey?: Secret;
    jupiterBaseUrl: 'https://api.jup.ag';
    dexScreenerBaseUrl: 'https://api.dexscreener.com';
  } = { jupiterBaseUrl: 'https://api.jup.ag', dexScreenerBaseUrl: 'https://api.dexscreener.com' };
  if (heliusKey) {
    registry.register(heliusKey);
    providers.heliusRpcUrl = registry.register(
      `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(heliusKey)}`,
    );
  }
  if (jupiterKey) providers.jupiterApiKey = registry.register(jupiterKey);
  const interval = integer(env, 'BOT_SNAPSHOT_INTERVAL_MS', 30_000, 30_000, 3_600_000);
  const maxAge = integer(
    env,
    'BOT_MAX_DATA_AGE_MS',
    Math.max(60_000, interval),
    interval,
    3_600_000,
  );
  return Object.freeze({
    mode,
    marketData,
    dashboardOrigin,
    databaseUrl: db,
    discovery,
    api: Object.freeze({
      host: '127.0.0.1' as const,
      port: integer(env, 'API_PORT', 3001, 1024, 65535),
    }),
    providers: Object.freeze(providers),
    limits: Object.freeze({
      monthlyServiceBudgetUsd: budget as 0,
      heliusMonthlyCreditStop: integer(env, 'BOT_HELIUS_MONTHLY_CREDIT_STOP', 800_000, 1, 800_000),
      jupiterRequestsPerMinute: integer(env, 'BOT_JUPITER_REQUESTS_PER_MINUTE', 20, 1, 20),
      watchlistSize: integer(env, 'BOT_WATCHLIST_SIZE', 10, 1, 10),
      snapshotIntervalMs: interval,
      maxDataAgeMs: maxAge,
    }),
  });
}
