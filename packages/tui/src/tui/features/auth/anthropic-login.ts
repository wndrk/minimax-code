import type { McodeProviderApplication } from '../../../provider/application.js';
import type { McodeAnthropicOAuthStatus } from '../../../provider/contract.js';
import { getKeybindings, Key, matchesKey } from '../../engine/public.js';
import type { Component } from '../../rendering/component.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import { wrapTextWithAnsi } from '../../rendering/text.js';
import { panelLayout } from '../../widgets/panel-frame.js';
import { tuiChalk as chalk, tuiColors as colors } from '../../theme/runtime.js';

interface AnthropicLoginOptions {
  application: Pick<
    McodeProviderApplication,
    'connectAnthropicOAuth' | 'getAnthropicOAuthStatus' | 'cancelAnthropicOAuthLogin'
  >;
  openExternalTarget(url: string): Promise<void>;
  onConnected(): void;
  onClose(): void;
  requestRender(): void;
}

/** Browser callback login for an Anthropic Claude Pro/Max subscription. */
export class TuiAnthropicLogin implements Component {
  readonly fullscreenViewport = true;
  readonly handlesViewportKeys = true;
  private phase: 'loading' | 'ready' | 'starting' | 'waiting' | 'failed' = 'loading';
  private status: McodeAnthropicOAuthStatus | undefined;
  private error: string | undefined;
  private browserHint: string | undefined;
  private openedUrl: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private cancelling = false;

  constructor(private readonly options: AnthropicLoginOptions) {}

  async resume(): Promise<void> {
    try {
      const status = await this.options.application.getAnthropicOAuthStatus();
      if (this.cancelling && status.loginId) {
        await this.options.application.cancelAnthropicOAuthLogin(status.loginId);
      } else if (!this.disposed) this.update(status);
    } catch (error) {
      this.fail(error);
    }
  }

  handleInput(data: string): void {
    if (this.disposed || this.cancelling) return;
    if (getKeybindings().matches(data, 'tui.select.cancel')) {
      void this.cancel();
    } else if ((this.phase === 'ready' || this.phase === 'failed') && matchesKey(data, Key.enter)) {
      void this.start();
    }
  }

  invalidate(): void {}

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
  }

  async cancel(): Promise<void> {
    if (this.cancelling) return;
    this.cancelling = true;
    clearTimeout(this.timer);
    try {
      if (this.status?.loginId) {
        await this.options.application.cancelAnthropicOAuthLogin(this.status.loginId);
      }
      if (!this.disposed) this.options.onClose();
    } catch (error) {
      this.cancelling = false;
      this.fail(error);
    }
  }

  render(width: number): string[] {
    return this.renderViewport(width, 20);
  }

  renderViewport(width: number, height: number): string[] {
    const footer =
      this.phase === 'ready' || this.phase === 'failed'
        ? 'Enter sign in · Esc cancel'
        : 'Esc cancel';
    const layout = panelLayout(width, height, footer);
    const body = this.body().flatMap((line) => wrapTextWithAnsi(line, layout.contentWidth));
    return layout.render({ title: 'Connect Anthropic', body }, this.error ? 'error' : 'signal');
  }

  private body(): string[] {
    if (this.cancelling) return ['Cancelling sign-in…'];
    if (this.phase === 'loading') return ['Checking Anthropic sign-in…'];
    if (this.phase === 'ready') return ['Press Enter to sign in with Claude Pro or Max.'];
    if (this.phase === 'starting') return ['Starting Anthropic sign-in…'];
    if (this.error) return [chalk.hex(colors.error)(this.error)];
    return [
      ...(this.status?.authUrl ? [sanitizeTerminalText(this.status.authUrl)] : []),
      'Complete sign-in in your browser.',
      'Waiting for authorization…',
      ...(this.browserHint ? [this.browserHint] : []),
    ];
  }

  private async start(): Promise<void> {
    this.phase = 'starting';
    this.error = undefined;
    this.browserHint = undefined;
    this.options.requestRender();
    try {
      const status = await this.options.application.connectAnthropicOAuth();
      if (this.cancelling && status.loginId) {
        await this.options.application.cancelAnthropicOAuthLogin(status.loginId);
        return;
      }
      if (!this.disposed) this.update(status);
    } catch (error) {
      if (!this.cancelling) this.fail(error);
    }
  }

  private update(status: McodeAnthropicOAuthStatus): void {
    if (this.cancelling) return;
    this.status = status;
    this.error = undefined;
    if (status.state === 'connected') {
      this.options.onConnected();
      return;
    }
    if (status.state === 'pending') {
      this.phase = 'waiting';
      if (status.authUrl && status.authUrl !== this.openedUrl) {
        this.openedUrl = status.authUrl;
        void this.openBrowser(status.authUrl);
      }
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.resume(), 1000);
      this.timer.unref?.();
    } else if (status.state === 'failed' || status.state === 'hidden') {
      this.phase = 'failed';
      this.error = sanitizeTerminalText(
        status.error ?? 'Anthropic sign-in is unavailable in this build.',
      );
    } else {
      this.phase = 'ready';
    }
    this.options.requestRender();
  }

  private async openBrowser(url: string): Promise<void> {
    try {
      await this.options.openExternalTarget(url);
    } catch {
      if (this.disposed) return;
      this.browserHint = 'Open the link above manually to continue.';
      this.options.requestRender();
    }
  }

  private fail(error: unknown): void {
    if (this.disposed) return;
    this.phase = 'failed';
    this.error = sanitizeTerminalText(
      error instanceof Error ? error.message : 'Anthropic sign-in failed. Retry to continue.',
    );
    this.options.requestRender();
  }
}
