import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { getModels } from '@earendil-works/pi-ai';
import { AuthStorage } from '@earendil-works/pi-coding-agent';

import type {
  LocalByokConfigDraft,
  LocalCustomProviderConfig,
  LocalCustomProvidersConfig,
  LocalRuntimeConfig,
} from './contracts.js';
import { ANTHROPIC_OAUTH_PROVIDER_ID } from './identity.js';

export { ANTHROPIC_OAUTH_PROVIDER_ID } from './identity.js';

export type AnthropicOAuthState = 'hidden' | 'disconnected' | 'pending' | 'connected' | 'failed';

export interface AnthropicOAuthStatus {
  state: AnthropicOAuthState;
  providerId: typeof ANTHROPIC_OAUTH_PROVIDER_ID;
  error?: string;
  loginId?: string;
  authUrl?: string;
}

type LoginAttempt = {
  id: string;
  controller: AbortController;
  start: Promise<AnthropicOAuthStatus>;
  resolve: (result: AnthropicOAuthStatus) => void;
  reject: (error: Error) => void;
  result?: AnthropicOAuthStatus;
  timeout?: ReturnType<typeof setTimeout>;
};

interface AnthropicAuthStorage {
  hasOAuth(provider: typeof ANTHROPIC_OAUTH_PROVIDER_ID): boolean;
  removeOAuth(provider: typeof ANTHROPIC_OAUTH_PROVIDER_ID): void;
  login(
    provider: typeof ANTHROPIC_OAUTH_PROVIDER_ID,
    callbacks: Parameters<AuthStorage['login']>[1],
  ): Promise<void>;
}

export interface AnthropicOAuthManagerDeps {
  configGetter: () => LocalRuntimeConfig;
  fetchImpl?: typeof fetch;
  updateByokConfig?: (
    mutate: (
      draft: LocalByokConfigDraft,
      currentConfig: LocalRuntimeConfig,
    ) => void | Promise<void>,
  ) => Promise<unknown>;
  removeLegacyProvider?: (providerId: typeof ANTHROPIC_OAUTH_PROVIDER_ID) => Promise<unknown>;
  authStorageFactory?: (authPath: string) => AnthropicAuthStorage;
}

export class AnthropicOAuthError extends Error {
  override name = 'AnthropicOAuthError';

  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** Owns Anthropic subscription login and projects its credentials into the provider catalog. */
export class AnthropicOAuthManager {
  private readonly authStorageFactory: (authPath: string) => AnthropicAuthStorage;
  private login: LoginAttempt | undefined;
  private lastError: string | undefined;

  constructor(private readonly deps: AnthropicOAuthManagerDeps) {
    this.authStorageFactory =
      deps.authStorageFactory ??
      ((authPath) => {
        const storage = AuthStorage.create(authPath);
        return {
          hasOAuth: (provider) => storage.getAll()[provider]?.type === 'oauth',
          removeOAuth: (provider) => {
            storage.logout(provider);
            const [error] = storage.drainErrors();
            if (error) throw error;
          },
          login: async (provider, callbacks) => {
            const pending = AuthStorage.inMemory();
            await pending.login(provider, callbacks);
            callbacks.signal?.throwIfAborted();
            const credentials = pending.getAll()[provider];
            if (!credentials) throw new Error('Anthropic OAuth credentials are unavailable.');
            storage.set(provider, credentials);
            const [error] = storage.drainErrors();
            if (error) throw error;
          },
        };
      });
  }

  getStatus(): AnthropicOAuthStatus {
    if (!this.enabled()) return this.status('hidden');
    if (this.login)
      return (
        this.login.result ?? {
          ...this.status('pending'),
          loginId: this.login.id,
        }
      );
    if (this.authStorage().hasOAuth(ANTHROPIC_OAUTH_PROVIDER_ID) && this.hasConfiguredProvider()) {
      return this.status('connected', this.lastError);
    }
    if (this.lastError) return this.status('failed', this.lastError);
    return this.status('disconnected');
  }

  async startLogin(): Promise<AnthropicOAuthStatus> {
    if (!this.enabled()) {
      throw new AnthropicOAuthError(404, 'Anthropic OAuth is not enabled.', 'FEATURE_DISABLED');
    }
    if (this.login) return this.login.start;
    const authStorage = this.authStorage();
    if (authStorage.hasOAuth(ANTHROPIC_OAUTH_PROVIDER_ID)) {
      if (!this.hasConfiguredProvider()) await this.configureProvider();
      this.lastError = undefined;
      return this.getStatus();
    }
    this.lastError = undefined;
    const attempt = this.createLoginAttempt();
    this.login = attempt;
    attempt.timeout = setTimeout(
      () => {
        if (this.login !== attempt) return;
        const error = new AnthropicOAuthError(
          408,
          'Anthropic sign-in timed out. Start login again.',
          'OAUTH_LOGIN_EXPIRED',
        );
        this.login = undefined;
        this.lastError = error.message;
        attempt.controller.abort(error);
        attempt.reject(error);
      },
      15 * 60 * 1000,
    );
    attempt.timeout.unref?.();
    const completion = this.finishLogin(authStorage, attempt);
    return Promise.race([attempt.start, completion]);
  }

  cancelLogin(loginId: string): AnthropicOAuthStatus {
    const attempt = this.login;
    if (!attempt || attempt.id !== loginId) return this.getStatus();
    this.login = undefined;
    this.lastError = undefined;
    clearTimeout(attempt.timeout);
    const error = new AnthropicOAuthError(
      409,
      'Anthropic OAuth login was cancelled.',
      'OAUTH_LOGIN_CANCELLED',
    );
    attempt.controller.abort(error);
    attempt.reject(error);
    return this.getStatus();
  }

  removeCredentials(providerId: string): void {
    if (providerId !== ANTHROPIC_OAUTH_PROVIDER_ID) {
      throw new AnthropicOAuthError(
        404,
        `OAuth credential storage does not support provider ${providerId}.`,
        'PROVIDER_AUTH_UNAVAILABLE',
      );
    }
    if (this.login) this.cancelLogin(this.login.id);
    this.authStorage().removeOAuth(ANTHROPIC_OAUTH_PROVIDER_ID);
    this.lastError = undefined;
  }

  private createLoginAttempt(): LoginAttempt {
    let resolve!: LoginAttempt['resolve'];
    let reject!: LoginAttempt['reject'];
    const start = new Promise<AnthropicOAuthStatus>((resolveStart, rejectStart) => {
      resolve = resolveStart;
      reject = rejectStart;
    });
    return {
      id: randomUUID(),
      controller: new AbortController(),
      start,
      resolve,
      reject,
    };
  }

  private loginCallbacks(attempt: LoginAttempt): Parameters<AnthropicAuthStorage['login']>[1] {
    const { signal } = attempt.controller;
    return {
      onAuth: ({ url }) => {
        if (!url.trim()) {
          throw new AnthropicOAuthError(
            502,
            'Anthropic OAuth returned no URL.',
            'OAUTH_START_FAILED',
          );
        }
        if (!attempt.result) {
          attempt.result = {
            ...this.status('pending'),
            loginId: attempt.id,
            authUrl: url.trim(),
          };
          attempt.resolve(attempt.result);
        }
      },
      onDeviceCode: () => {
        throw new Error('Anthropic OAuth does not support device-code login.');
      },
      onPrompt: async () => {
        throw new Error('Anthropic OAuth browser callback expired. Start login again.');
      },
      onSelect: async () => undefined,
      onManualCodeInput: () =>
        new Promise<string>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
        }),
      signal,
      fetch: async (input, init) => {
        const requestSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(30_000),
          ...(init?.signal ? [init.signal] : []),
        ]);
        return (this.deps.fetchImpl ?? globalThis.fetch)(input, {
          ...init,
          signal: requestSignal,
        });
      },
    };
  }

  private async finishLogin(
    authStorage: AnthropicAuthStorage,
    attempt: LoginAttempt,
  ): Promise<AnthropicOAuthStatus> {
    try {
      await authStorage.login(ANTHROPIC_OAUTH_PROVIDER_ID, this.loginCallbacks(attempt));
      attempt.controller.signal.throwIfAborted();
      await this.configureProvider();
      if (this.login !== attempt) return this.getStatus();
      this.login = undefined;
      this.lastError = undefined;
      const connected = this.getStatus();
      attempt.resolve(connected);
      return connected;
    } catch (error) {
      if (this.login !== attempt) return this.getStatus();
      const cause: unknown = attempt.controller.signal.reason ?? error;
      this.login = undefined;
      this.lastError = anthropicOAuthErrorMessage(cause);
      const failure =
        cause instanceof AnthropicOAuthError
          ? cause
          : new AnthropicOAuthError(502, this.lastError, 'OAUTH_LOGIN_FAILED');
      attempt.reject(failure);
      throw failure;
    } finally {
      clearTimeout(attempt.timeout);
    }
  }

  private enabled(): boolean {
    return this.deps.configGetter().beta?.anthropicOAuth === true;
  }

  private authStorage(): AnthropicAuthStorage {
    return this.authStorageFactory(join(this.deps.configGetter().dataDir, 'codex-auth.json'));
  }

  private hasConfiguredProvider(): boolean {
    return Boolean(
      this.deps.configGetter().custom_provider?.[ANTHROPIC_OAUTH_PROVIDER_ID]?.models &&
      Object.keys(
        this.deps.configGetter().custom_provider?.[ANTHROPIC_OAUTH_PROVIDER_ID]?.models ?? {},
      ).length > 0,
    );
  }

  private async configureProvider(): Promise<void> {
    const updater = this.deps.updateByokConfig;
    if (!updater) {
      throw new AnthropicOAuthError(
        503,
        'Anthropic OAuth provider configuration is unavailable.',
        'PROVIDER_CONFIG_UNAVAILABLE',
      );
    }
    const hasLegacyProvider = Boolean(
      this.deps.configGetter().provider?.[ANTHROPIC_OAUTH_PROVIDER_ID],
    );
    if (hasLegacyProvider && !this.deps.removeLegacyProvider) {
      throw new AnthropicOAuthError(
        503,
        'Anthropic OAuth legacy provider removal is unavailable.',
        'PROVIDER_CONFIG_UNAVAILABLE',
      );
    }
    await updater((draft, currentConfig) => configureAnthropicOAuthProvider(draft, currentConfig));
    if (hasLegacyProvider) {
      await this.deps.removeLegacyProvider?.(ANTHROPIC_OAUTH_PROVIDER_ID);
    }
  }

  private status(state: AnthropicOAuthState, error?: string): AnthropicOAuthStatus {
    return {
      state,
      providerId: ANTHROPIC_OAUTH_PROVIDER_ID,
      ...(error ? { error } : {}),
    };
  }
}

function configureAnthropicOAuthProvider(
  draft: LocalByokConfigDraft,
  currentConfig: LocalRuntimeConfig,
): void {
  const tree = (draft.custom_provider ?? {}) as LocalCustomProvidersConfig;
  const customCurrent = currentConfig.custom_provider?.[ANTHROPIC_OAUTH_PROVIDER_ID];
  const current = customCurrent ?? currentConfig.provider?.[ANTHROPIC_OAUTH_PROVIDER_ID];
  const currentOptions = { ...(current?.options ?? {}) };
  delete currentOptions.apiKey;
  tree[ANTHROPIC_OAUTH_PROVIDER_ID] = {
    ...current,
    name: current?.name ?? 'Anthropic',
    api: 'anthropic-messages',
    kind: 'oauth',
    enabled: customCurrent?.enabled ?? true,
    options: {
      ...currentOptions,
      baseURL: current?.options?.baseURL ?? 'https://api.anthropic.com',
      authMode: 'oauth',
    },
    models: mergeAnthropicModels(current?.models ?? {}),
  } satisfies LocalCustomProviderConfig;
  draft.custom_provider = tree as Record<string, unknown>;
  if (draft.defaultModel?.startsWith(`${ANTHROPIC_OAUTH_PROVIDER_ID}/`)) {
    draft.defaultModel = `custom_provider:${draft.defaultModel}`;
  }
}

function mergeAnthropicModels(
  current: NonNullable<LocalCustomProviderConfig['models']>,
): NonNullable<LocalCustomProviderConfig['models']> {
  const models = new Map(Object.entries(current));
  for (const model of getModels('anthropic')) {
    models.set(model.id, {
      name: model.name,
      reasoning: model.reasoning,
      attachment: model.input.includes('image'),
      tool_call: true,
      limit: { context: model.contextWindow, output: model.maxTokens },
      modalities: { input: [...model.input], output: ['text'] },
      ...models.get(model.id),
    });
  }
  return Object.fromEntries(models);
}

function anthropicOAuthErrorMessage(error: unknown): string {
  if (error instanceof AnthropicOAuthError) return error.message;
  const message = error instanceof Error ? error.message : '';
  if (message.includes('callback expired')) return message;
  if (message.includes('EADDRINUSE')) {
    return 'Anthropic OAuth callback port 53692 is already in use.';
  }
  if (message === 'Login cancelled') return 'Anthropic OAuth login was cancelled.';
  return 'Anthropic OAuth login failed.';
}
