import { test } from 'vitest';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { ConfigurationError, loadConfig } from './config.js';
import type { Environment } from './config.js';
import { SecretRegistry } from './secrets.js';
import { createLogger } from './logger.js';
import { encryptSecret, decryptSecret } from './vault.js';
import { randomBytes } from 'node:crypto';
import { createAppContext } from './context.js';

const base = { DATABASE_URL: 'postgresql://127.0.0.1:5432/bot_paper' };

test('minimal startup is offline, paper-only, loopback and zero-budget', () => {
  const config = loadConfig(base);
  assert.equal(config.mode, 'paper');
  assert.equal(config.marketData, 'fixtures');
  assert.deepEqual(config.api, { host: '127.0.0.1', port: 3001 });
  assert.equal(config.limits.monthlyServiceBudgetUsd, 0);
  assert.equal(config.limits.jupiterRequestsPerMinute, 20);
  assert.equal(config.providers.heliusRpcUrl, undefined);
});

test('clear startup failure contains field names, not user input', () => {
  assert.throws(
    () => loadConfig({}),
    (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.deepEqual(error.fields, ['DATABASE_URL']);
      assert.match(error.message, /Invalid or missing configuration/);
      return true;
    },
  );
  const secret = 'synthetic-private-do-not-print';
  assert.throws(
    () => loadConfig({ DATABASE_URL: secret }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.ok(!String(error).includes(secret));
      return true;
    },
  );
});

test('reject live/invalid modes and all known signing material', () => {
  for (const mode of ['live', 'LIVE', '', ' paper ', 'off']) {
    {
      assert.throws(() => loadConfig({ ...base, BOT_MODE: mode }), ConfigurationError);
    }
  }
  for (const key of [
    'PRIVATE_KEY',
    'SOLANA_PRIVATE_KEY',
    'WALLET_SECRET_KEY',
    'MNEMONIC',
    'SEED_PHRASE',
    'KEYPAIR',
    'ENABLE_LIVE_TRADING',
  ]) {
    assert.throws(
      () => loadConfig({ ...base, [key]: 'synthetic-key' }),
      /SIGNING_CONFIGURATION_NOT_ALLOWED/,
    );
  }
});

test('reject malformed and over-budget numeric settings', () => {
  for (const value of [
    '-1',
    '1.2',
    'NaN',
    'Infinity',
    '1e3',
    ' 3001',
    '03001',
    '',
    '65536',
    '9007199254740993',
  ]) {
    assert.throws(() => loadConfig({ ...base, API_PORT: value }), /API_PORT/);
  }
  for (const [key, value] of Object.entries({
    BOT_MONTHLY_SERVICE_BUDGET_USD: '1',
    BOT_HELIUS_MONTHLY_CREDIT_STOP: '800001',
    BOT_JUPITER_REQUESTS_PER_MINUTE: '21',
    BOT_WATCHLIST_SIZE: '11',
    BOT_SNAPSHOT_INTERVAL_MS: '29999',
    BOT_MAX_DATA_AGE_MS: '29999',
  })) {
    assert.throws(() => loadConfig({ ...base, [key]: value }), ConfigurationError);
  }
});

test('reject database URLs that escape local hosting or conceal host overrides', () => {
  for (const value of [
    'https://localhost/bot',
    'postgresql://remote.example/bot',
    'postgresql://localhost/',
    'postgresql://localhost/bot?host=remote.example',
    'postgresql://localhost/bot#fragment',
    ' postgresql://localhost/bot',
    'postgresql://user:%xx@localhost/bot',
  ]) {
    assert.throws(() => loadConfig({ DATABASE_URL: value }), /DATABASE_URL/);
  }
  assert.equal(
    loadConfig({ DATABASE_URL: 'postgresql://[::1]/bot' }).databaseUrl.reveal(),
    'postgresql://[::1]/bot',
  );
});

test('mainnet needs a key and fixed provider endpoints; no requests are made', () => {
  assert.throws(() => loadConfig({ ...base, BOT_MARKET_DATA: 'mainnet' }), /HELIUS_API_KEY/);
  const config = loadConfig({
    ...base,
    BOT_MARKET_DATA: 'mainnet',
    HELIUS_API_KEY: 'synthetic/key+123',
  });
  assert.equal(
    config.providers.heliusRpcUrl?.reveal(),
    'https://mainnet.helius-rpc.com/?api-key=synthetic%2Fkey%2B123',
  );
  assert.throws(() => loadConfig({ ...base, HELIUS_API_KEY: '' }), /HELIUS_API_KEY/);
  assert.throws(() => loadConfig({ ...base, JUPITER_API_KEY: ' bad\nkey' }), /JUPITER_API_KEY/);
  assert.throws(() => loadConfig({ ...base, HELIUS_API_KEY: '\ud800' }), /HELIUS_API_KEY/);
});

test('default data expiry grows with the polling interval; explicit inconsistency is rejected', () => {
  const config = loadConfig({ ...base, BOT_SNAPSHOT_INTERVAL_MS: '120000' });
  assert.equal(config.limits.maxDataAgeMs, 120000);
  assert.throws(
    () => loadConfig({ ...base, BOT_SNAPSHOT_INTERVAL_MS: '120000', BOT_MAX_DATA_AGE_MS: '60000' }),
    /BOT_MAX_DATA_AGE_MS/,
  );
});

test('unknown settings, inherited values and getters cannot change the configuration', () => {
  assert.throws(() => loadConfig({ ...base, BOT_MDOE: 'live' }), /UNKNOWN_BOT_SETTING/);
  const inherited = Object.create({ DATABASE_URL: base.DATABASE_URL });
  assert.throws(() => loadConfig(inherited), /DATABASE_URL/);
  let invoked = false;
  const hostile = Object.defineProperty({}, 'DATABASE_URL', {
    get() {
      invoked = true;
      throw new Error('synthetic-secret');
    },
  });
  assert.throws(() => loadConfig(hostile), /ENVIRONMENT/);
  assert.equal(invoked, false);
  assert.throws(() => loadConfig({ DATABASE_URL: 1 } as unknown as Environment), /DATABASE_URL/);
  assert.throws(
    () =>
      loadConfig(
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error('synthetic-secret');
            },
          },
        ),
      ),
    /ENVIRONMENT/,
  );
});

test('validated configuration and nested settings cannot be mutated', () => {
  const config = loadConfig(base);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.providers));
  assert.ok(Object.isFrozen(config.limits));
  assert.ok(Object.isFrozen(config.api));
  assert.equal(Reflect.set(config, 'mode', 'live'), false);
  assert.equal(Reflect.set(config.limits, 'monthlyServiceBudgetUsd', 49), false);
  assert.equal(config.mode, 'paper');
});

test('configured credentials stay out of JSON, inspect and actual logger output', () => {
  const sentinel = 'synthetic-H3lius-credential-849';
  const password = 'synthetic-db-password-621';
  const registry = new SecretRegistry();
  const config = loadConfig(
    { DATABASE_URL: `postgresql://bot:${password}@127.0.0.1/bot`, HELIUS_API_KEY: sentinel },
    registry,
  );
  const lines: string[] = [];
  createLogger(registry, (line) => lines.push(line)).info('configuration_loaded', {
    config,
    error: new Error(`request ${sentinel} failed`),
  });
  const observed = [JSON.stringify(config), inspect(config), ...lines].join('\n');
  for (const secret of [sentinel, password, encodeURIComponent(sentinel)])
    assert.ok(!observed.includes(secret));
  assert.equal(lines.length, 1);
  assert.doesNotThrow(() => JSON.parse(lines[0]!));
});

test('encrypted environment mapping decrypts in memory and loads without logging plaintext', () => {
  const key = randomBytes(32);
  const plaintext = JSON.stringify({ ...base, HELIUS_API_KEY: 'synthetic-vault-api-2782' });
  const envelope = encryptSecret(plaintext, key);
  const registry = new SecretRegistry();
  const config = loadConfig(JSON.parse(decryptSecret(envelope, key)), registry);
  assert.ok(!envelope.includes('synthetic-vault-api-2782'));
  assert.ok(!JSON.stringify(config).includes('synthetic-vault-api-2782'));
});

test('encrypted settings integrate with startup and redact the key, envelope and plaintext', () => {
  const key = randomBytes(32);
  const plaintext = JSON.stringify({ ...base, HELIUS_API_KEY: 'synthetic-encrypted-startup-729' });
  const envelope = encryptSecret(plaintext, key);
  const lines: string[] = [];
  const context = createAppContext(
    { BOT_ENCRYPTED_CONFIG: envelope, BOT_CONFIG_ENCRYPTION_KEY: key.toString('base64') },
    (line) => lines.push(line),
  );
  assert.ok(context);
  assert.equal(context.config.databaseUrl.reveal(), base.DATABASE_URL);
  context.logger.error('provider_failed', {
    details: `${plaintext} ${envelope} ${key.toString('base64')}`,
  });
  for (const secret of [
    plaintext,
    envelope,
    key.toString('base64'),
    'synthetic-encrypted-startup-729',
  ]) {
    assert.ok(!lines.join('\n').includes(secret));
  }
});

test('encrypted source fails closed on wrong keys, missing pairs, unexpected fields and duplicates', () => {
  const key = randomBytes(32);
  const encrypted = {
    BOT_ENCRYPTED_CONFIG: encryptSecret(JSON.stringify(base), key),
    BOT_CONFIG_ENCRYPTION_KEY: key.toString('base64'),
  };
  assert.throws(
    () =>
      loadConfig({ ...encrypted, BOT_CONFIG_ENCRYPTION_KEY: randomBytes(32).toString('base64') }),
    /BOT_ENCRYPTED_CONFIG/,
  );
  assert.throws(
    () => loadConfig({ ...encrypted, BOT_CONFIG_ENCRYPTION_KEY: 'invalid' }),
    /BOT_CONFIG_ENCRYPTION_KEY/,
  );
  assert.throws(
    () => loadConfig({ ...base, BOT_ENCRYPTED_CONFIG: encrypted.BOT_ENCRYPTED_CONFIG }),
    /BOT_CONFIG_ENCRYPTION_KEY/,
  );
  assert.throws(
    () => loadConfig({ ...base, BOT_CONFIG_ENCRYPTION_KEY: encrypted.BOT_CONFIG_ENCRYPTION_KEY }),
    /BOT_ENCRYPTED_CONFIG/,
  );
  assert.throws(() => loadConfig({ ...base, ...encrypted }), /DATABASE_URL/);
  assert.throws(
    () =>
      loadConfig({
        ...encrypted,
        BOT_ENCRYPTED_CONFIG: encryptSecret(JSON.stringify({ BOT_MODE: 'live' }), key),
      }),
    /BOT_ENCRYPTED_CONFIG/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...encrypted,
        BOT_ENCRYPTED_CONFIG: encryptSecret(JSON.stringify({ PRIVATE_KEY: 'synthetic-key' }), key),
      }),
    /BOT_ENCRYPTED_CONFIG/,
  );
});

test('startup diagnostics never echo invalid secrets before registration', () => {
  const lines: string[] = [];
  assert.equal(
    createAppContext({ DATABASE_URL: 'synthetic-bad-secret-927' }, (line) => lines.push(line)),
    undefined,
  );
  assert.match(lines[0]!, /DATABASE_URL/);
  assert.ok(!lines[0]!.includes('synthetic-bad-secret-927'));
  assert.throws(() => loadConfig({ ...base, API_HOST: '0.0.0.0' }), /API_HOST/);
});

test('discovery is independently opt-in on free public endpoints with wrapped immutable settings', () => {
  const defaults = loadConfig(base);
  assert.equal(defaults.discovery.enabled, false);
  assert.equal(defaults.discovery.rpcUrl.reveal(), 'https://api.mainnet-beta.solana.com/');
  assert.equal(defaults.discovery.wsUrl.reveal(), 'wss://api.mainnet-beta.solana.com/');
  assert.ok(Object.isFrozen(defaults.discovery));
  const enabled = loadConfig({ ...base, MARKET_DATA_ENABLED: 'true' });
  assert.equal(enabled.discovery.enabled, true);
  assert.equal(enabled.marketData, 'fixtures');
  assert.equal(enabled.providers.heliusRpcUrl, undefined);
});

test('discovery config rejects invalid endpoints and boolean values without reflecting secrets', () => {
  for (const MARKET_DATA_ENABLED of ['1', '', 'TRUE', ' true ']) {
    assert.throws(() => loadConfig({ ...base, MARKET_DATA_ENABLED }), /MARKET_DATA_ENABLED/);
  }
  for (const [field, value] of [
    ['SOLANA_RPC_URL', 'file:///synthetic-token'],
    ['SOLANA_RPC_URL', ' https://synthetic-token.example'],
    ['SOLANA_RPC_URL', 'https://synthetic-token.example/#fragment'],
    ['SOLANA_RPC_URL', 'https://user:%zz@example.test'],
    ['SOLANA_WS_URL', 'https://synthetic-token.example'],
    ['SOLANA_WS_URL', 'wss://synthetic-token.example/\n'],
  ]) {
    assert.throws(
      () => loadConfig({ ...base, [field!]: value }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.ok(error.fields.includes(field!));
        assert.ok(!error.message.includes('synthetic-token'));
        return true;
      },
    );
  }
});

test('discovery URL credentials and arbitrary query tokens are registered before runtime logging', () => {
  const registry = new SecretRegistry();
  const config = loadConfig(
    {
      ...base,
      SOLANA_RPC_URL:
        'https://synthetic-user:synthetic-password@example.test/rpc?custom=synthetic-query-token',
      SOLANA_WS_URL: 'wss://example.test/socket?custom=synthetic-ws-token',
    },
    registry,
  );
  const lines: string[] = [];
  createLogger(registry, (line) => lines.push(line)).error('provider_failed', {
    config,
    message: 'synthetic-user synthetic-password synthetic-query-token synthetic-ws-token',
  });
  const output = lines.join('\n') + JSON.stringify(config) + inspect(config);
  for (const value of [
    'synthetic-user',
    'synthetic-password',
    'synthetic-query-token',
    'synthetic-ws-token',
  ])
    assert.ok(!output.includes(value));
});

test('encrypted discovery endpoints supplement environment and reject duplicate definitions', () => {
  const key = randomBytes(32);
  const encrypted = {
    BOT_ENCRYPTED_CONFIG: encryptSecret(
      JSON.stringify({
        SOLANA_RPC_URL: 'https://example.test/?key=synthetic-encrypted-rpc',
        SOLANA_WS_URL: 'wss://example.test/?key=synthetic-encrypted-ws',
      }),
      key,
    ),
    BOT_CONFIG_ENCRYPTION_KEY: key.toString('base64'),
  };
  const config = loadConfig({ ...base, ...encrypted });
  assert.equal(
    config.discovery.rpcUrl.reveal(),
    'https://example.test/?key=synthetic-encrypted-rpc',
  );
  assert.throws(
    () => loadConfig({ ...base, ...encrypted, SOLANA_RPC_URL: 'https://example.test' }),
    /SOLANA_RPC_URL/,
  );
});

test('accepts only exact loopback dashboard origins with an explicit port', () => {
  assert.equal(loadConfig(base).dashboardOrigin, 'http://127.0.0.1:5173');
  assert.equal(
    loadConfig({ ...base, API_DASHBOARD_ORIGIN: 'http://127.0.0.1:5180' }).dashboardOrigin,
    'http://127.0.0.1:5180',
  );
  for (const origin of [
    'https://example.com',
    'http://0.0.0.0:5173',
    'http://127.0.0.1',
    'http://127.0.0.1:5173/',
    'http://user:pass@127.0.0.1:5173',
    'http://127.0.0.1:5173/path',
  ])
    assert.throws(
      () => loadConfig({ ...base, API_DASHBOARD_ORIGIN: origin }),
      /API_DASHBOARD_ORIGIN/,
    );
});
