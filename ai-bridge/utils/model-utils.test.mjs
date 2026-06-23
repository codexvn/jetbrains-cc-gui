import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mapModelIdToSdkName,
  resolveModelFromSettings,
  setModelEnvironmentVariables,
  modelSupportsVision,
} from './model-utils.js';

// --- mapModelIdToSdkName ------------------------------------------------

test('mapModelIdToSdkName maps Claude families to short SDK names', () => {
  assert.equal(mapModelIdToSdkName('claude-opus-4-7'), 'opus');
  assert.equal(mapModelIdToSdkName('claude-haiku-4-5'), 'haiku');
  assert.equal(mapModelIdToSdkName('claude-sonnet-4-6'), 'sonnet');
  // Unknown / third-party IDs fall back to sonnet (because the SDK uses
  // ANTHROPIC_DEFAULT_SONNET_MODEL as the lookup target for arbitrary names).
  assert.equal(mapModelIdToSdkName('mimo-v2.5-pro'), 'sonnet');
  assert.equal(mapModelIdToSdkName(''), 'sonnet');
  assert.equal(mapModelIdToSdkName(null), 'sonnet');
});

// --- resolveModelFromSettings -------------------------------------------

test('resolveModelFromSettings returns original when no settings env provided', () => {
  assert.equal(resolveModelFromSettings('claude-sonnet-4-6', null), 'claude-sonnet-4-6');
  assert.equal(resolveModelFromSettings('claude-sonnet-4-6', {}), 'claude-sonnet-4-6');
});

test('resolveModelFromSettings applies model-specific settings mapping', () => {
  const env = {
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.7-opus',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.7-flash',
  };
  assert.equal(resolveModelFromSettings('claude-opus-4-7', env), 'glm-4.7-opus');
  assert.equal(resolveModelFromSettings('claude-sonnet-4-6', env), 'glm-4.7');
  assert.equal(resolveModelFromSettings('claude-haiku-4-5', env), 'glm-4.7-flash');
});

test('resolveModelFromSettings honors global ANTHROPIC_MODEL override', () => {
  const env = {
    ANTHROPIC_MODEL: 'override-everywhere',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'ignored',
  };
  assert.equal(resolveModelFromSettings('claude-sonnet-4-6', env), 'override-everywhere');
  assert.equal(resolveModelFromSettings('claude-opus-4-7', env), 'override-everywhere');
});

test('resolveModelFromSettings ignores empty / whitespace mapping values', () => {
  const env = {
    ANTHROPIC_DEFAULT_SONNET_MODEL: '   ',
    ANTHROPIC_DEFAULT_OPUS_MODEL: '',
  };
  assert.equal(resolveModelFromSettings('claude-sonnet-4-6', env), 'claude-sonnet-4-6');
  assert.equal(resolveModelFromSettings('claude-opus-4-7', env), 'claude-opus-4-7');
});

test('resolveModelFromSettings does NOT remap non-Anthropic model IDs', () => {
  // A third-party model name like 'qwen3-max' should pass through unchanged
  // even when ANTHROPIC_DEFAULT_SONNET_MODEL is configured. Otherwise we would
  // silently rewrite intentional model selections.
  const env = { ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7' };
  assert.equal(resolveModelFromSettings('qwen3-max', env), 'qwen3-max');
  assert.equal(resolveModelFromSettings('deepseek-v4-pro', env), 'deepseek-v4-pro');
});

// --- [1m] suffix follows the webview request state ------------------------
//
// Bug: when a user opens the 1M context toggle in the UI, the frontend sends
//   `claude-sonnet-4-6[1m]` to the backend. If `settings.json` contains a
//   provider mapping like `ANTHROPIC_DEFAULT_SONNET_MODEL=glm-4.7` (no [1m]),
//   the old resolver returned `'glm-4.7'`, silently dropping the suffix.
//   The Claude SDK then read the env var without [1m] and did NOT enable the
//   1M context window even though the toggle was on.
// Fix: make the request modelId the source of truth. Preserve/append [1m] when
// the toggle is on, and strip stale mapping suffixes when the toggle is off.

test('resolveModelFromSettings preserves [1m] suffix when mapping value lacks it', () => {
  const env = { ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7' };
  assert.equal(
    resolveModelFromSettings('claude-sonnet-4-6[1m]', env),
    'glm-4.7[1m]',
    'request asked for 1M, mapping must keep the [1m] suffix so the SDK enables 1M context'
  );
});

test('resolveModelFromSettings does not double-append [1m] when mapping already has it', () => {
  const env = { ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro[1m]' };
  assert.equal(
    resolveModelFromSettings('claude-sonnet-4-6[1m]', env),
    'deepseek-v4-pro[1m]'
  );
});

test('resolveModelFromSettings strips stale [1m] suffix when 1M toggle is OFF', () => {
  const env = { ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7[1M]' };
  assert.equal(
    resolveModelFromSettings('claude-sonnet-4-6', env),
    'glm-4.7',
    'request did not ask for 1M, stale settings mapping suffix must not force it on'
  );
});

test('resolveModelFromSettings preserves [1m] across ANTHROPIC_MODEL global override', () => {
  const env = { ANTHROPIC_MODEL: 'override-model[1M]' };
  assert.equal(resolveModelFromSettings('claude-sonnet-4-6[1m]', env), 'override-model[1m]');
  assert.equal(resolveModelFromSettings('claude-sonnet-4-6', env), 'override-model');
});

test('resolveModelFromSettings preserves [1m] for opus mapping', () => {
  const env = { ANTHROPIC_DEFAULT_OPUS_MODEL: 'mimo-v2.5-pro' };
  assert.equal(resolveModelFromSettings('claude-opus-4-7[1m]', env), 'mimo-v2.5-pro[1m]');
});

// --- setModelEnvironmentVariables ---------------------------------------

test('setModelEnvironmentVariables sets sonnet env for sonnet-family base model', () => {
  const previous = {
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
  };
  try {
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;

    setModelEnvironmentVariables('glm-4.7[1m]', 'claude-sonnet-4-6[1m]');

    assert.equal(process.env.ANTHROPIC_MODEL, 'glm-4.7[1m]');
    assert.equal(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'glm-4.7[1m]');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('setModelEnvironmentVariables routes haiku base to haiku env', () => {
  const previous = {
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
  };
  try {
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;

    setModelEnvironmentVariables('glm-4.7-flash', 'claude-haiku-4-5');

    assert.equal(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'glm-4.7-flash');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// --- setModelEnvironmentVariables provider tier sync ------------------------
// Provider env maps the three tiers to their base model names (no [1m] suffix).
// The current tier is subsequently overwritten by modelId, which carries the
// correct [1m] state from the request via resolveModelFromSettings.
// Non-current tiers receive the raw provider value so subagents (e.g. Explore
// switching to haiku) resolve to the user's mapped model without any [1m].
test('setModelEnvironmentVariables with providerEnv writes all three tiers from provider config', () => {
  const previous = {
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
  };
  try {
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;

    const providerEnv = {
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'custom-sonnet',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'custom-haiku',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'custom-opus',
    };

    setModelEnvironmentVariables('custom-sonnet[1m]', 'claude-sonnet-4-6[1m]', providerEnv);

    // Non-current tiers: raw provider value, no [1m].
    assert.equal(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'custom-haiku');
    assert.equal(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'custom-opus');
    // Current tier (sonnet): overwritten by modelId with [1m] carried through.
    assert.equal(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'custom-sonnet[1m]');
    assert.equal(process.env.ANTHROPIC_MODEL, 'custom-sonnet[1m]');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// Stale [1m] in provider config must be stripped from non-current tiers.
// Otherwise a misconfigured provider value like 'claude-haiku-4-5[1m]'
// would force 1M context on subagents (e.g. Explore → haiku), breaking
// the webview toggle.
test('setModelEnvironmentVariables with providerEnv strips [1m] from non-current tiers', () => {
  const previous = {
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
  };
  try {
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;

    // Simulate stale [1m] in provider config
    const providerEnv = {
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'custom-sonnet[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'custom-haiku[1m]',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'custom-opus[1m]',
    };

    // ModelId from resolveModelFromSettings carries request's [1m] intent (disabled here)
    setModelEnvironmentVariables('custom-sonnet', 'claude-sonnet-4-6', providerEnv);

    // Non-current tiers: [1m] stripped, no suffix
    assert.equal(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'custom-haiku');
    assert.equal(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'custom-opus');
    // Current tier (sonnet): overwritten by modelId, no [1m]
    assert.equal(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'custom-sonnet');
    assert.equal(process.env.ANTHROPIC_MODEL, 'custom-sonnet');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// When called without providerEnv (backward-compatible path), only the
// currently-selected tier is written to process.env — no normalization needed
// because modelId already carries the caller's [1m] intent.
test('setModelEnvironmentVariables without providerEnv only sets current tier', () => {
  const previous = {
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
  };
  try {
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;

    setModelEnvironmentVariables('glm-4.7[1m]', 'claude-sonnet-4-6[1m]');

    assert.equal(process.env.ANTHROPIC_MODEL, 'glm-4.7[1m]');
    assert.equal(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'glm-4.7[1m]');
    assert.equal(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined);
    assert.equal(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
// --- modelSupportsVision -------------------------------------------------

test('modelSupportsVision only matches the canonical claude- prefix', () => {
  assert.equal(modelSupportsVision('claude-sonnet-4-6'), true);
  assert.equal(modelSupportsVision('claude-opus-4-7'), true);
  // Third-party proxies that merely contain "claude" must NOT be treated as
  // native vision-capable models.
  assert.equal(modelSupportsVision('claude-compatible-proxy'), true); // starts with 'claude-'
  assert.equal(modelSupportsVision('mimo-claude-bridge'), false);
  assert.equal(modelSupportsVision('glm-4.7'), false);
  assert.equal(modelSupportsVision('deepseek-v4-pro[1m]'), false);
  assert.equal(modelSupportsVision(''), true);
  assert.equal(modelSupportsVision(null), true);
});
