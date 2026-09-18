import { AuthStorage } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';

import type { LocalByokConfigDraft, LocalRuntimeConfig } from './contracts.js';
import { AnthropicOAuthError, AnthropicOAuthManager } from './anthropic-oauth.js';

function createConfig(enabled: boolean): LocalRuntimeConfig {
  return {
    dataDir: '/tmp/model-system-anthropic-oauth-test',
    provider: {},
    beta: { anthropicOAuth: enabled },
  };
}

function createUpdater(target: LocalRuntimeConfig) {
  return vi.fn(
    async (
      mutate: (
        draft: LocalByokConfigDraft,
        currentConfig: LocalRuntimeConfig,
      ) => void | Promise<void>,
    ) => {
      const draft: LocalByokConfigDraft = {
        custom_provider: target.custom_provider
          ? structuredClone(target.custom_provider)
          : undefined,
        defaultModel: target.defaultModel,
      };
      await mutate(draft, target);
      target.custom_provider = draft.custom_provider as LocalRuntimeConfig['custom_provider'];
      target.defaultModel = draft.defaultModel;
    },
  );
}

describe('AnthropicOAuthManager', () => {
  it('stays hidden and does not start Pi login while disabled', async () => {
    const login = vi.fn();
    const manager = new AnthropicOAuthManager({
      configGetter: () => createConfig(false),
      authStorageFactory: () => ({
        hasOAuth: () => false,
        removeOAuth: vi.fn(),
        login,
      }),
    });

    expect(manager.getStatus()).toEqual({
      state: 'hidden',
      providerId: 'anthropic',
    });
    await expect(manager.startLogin()).rejects.toMatchObject({
      status: 404,
      code: 'FEATURE_DISABLED',
    } satisfies Partial<AnthropicOAuthError>);
    expect(login).not.toHaveBeenCalled();
  });

  it('projects existing OAuth credentials into an isolated Anthropic provider', async () => {
    const config = createConfig(true);
    const manager = new AnthropicOAuthManager({
      configGetter: () => config,
      updateByokConfig: createUpdater(config),
      authStorageFactory: () => ({
        hasOAuth: () => true,
        removeOAuth: vi.fn(),
        login: vi.fn(),
      }),
    });

    await expect(manager.startLogin()).resolves.toMatchObject({
      state: 'connected',
    });
    expect(config.custom_provider?.anthropic).toMatchObject({
      name: 'Anthropic',
      api: 'anthropic-messages',
      kind: 'oauth',
      options: {
        authMode: 'oauth',
        baseURL: 'https://api.anthropic.com',
      },
    });
    expect(Object.keys(config.custom_provider?.anthropic?.models ?? {})).toContain(
      'claude-sonnet-4-6',
    );
    expect(config.custom_provider?.anthropic?.options?.apiKey).toBeUndefined();
  });

  it('returns the authorization URL and aborts a cancelled callback login', async () => {
    const config = createConfig(true);
    const login = vi.fn(
      async (_provider: string, callbacks: Parameters<AuthStorage['login']>[1]) => {
        callbacks.onAuth({ url: 'https://claude.ai/oauth/authorize?test=1' });
        await new Promise((_resolve, reject) =>
          callbacks.signal?.addEventListener('abort', () => reject(callbacks.signal?.reason), {
            once: true,
          }),
        );
      },
    );
    const manager = new AnthropicOAuthManager({
      configGetter: () => config,
      authStorageFactory: () => ({
        hasOAuth: () => false,
        removeOAuth: vi.fn(),
        login,
      }),
    });

    const pending = await manager.startLogin();
    expect(pending).toMatchObject({
      state: 'pending',
      providerId: 'anthropic',
      authUrl: 'https://claude.ai/oauth/authorize?test=1',
    });
    expect(manager.cancelLogin(pending.loginId!)).toEqual({
      state: 'disconnected',
      providerId: 'anthropic',
    });
  });

  it('persists the provider catalog after callback login completes', async () => {
    const config = createConfig(true);
    const manager = new AnthropicOAuthManager({
      configGetter: () => config,
      updateByokConfig: createUpdater(config),
      authStorageFactory: () => ({
        hasOAuth: () => Boolean(config.custom_provider?.anthropic),
        removeOAuth: vi.fn(),
        login: vi.fn(async (_provider, callbacks) => {
          callbacks.onAuth({ url: 'https://claude.ai/oauth/authorize?test=1' });
        }),
      }),
    });

    await expect(manager.startLogin()).resolves.toMatchObject({
      state: 'pending',
      authUrl: 'https://claude.ai/oauth/authorize?test=1',
    });
    await vi.waitFor(() => expect(manager.getStatus().state).toBe('connected'));
    expect(config.custom_provider?.anthropic?.options).toMatchObject({
      authMode: 'oauth',
      baseURL: 'https://api.anthropic.com',
    });
  });
});
