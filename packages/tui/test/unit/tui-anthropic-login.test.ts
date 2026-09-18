import { afterEach, describe, expect, it, vi } from "vitest";
import type { McodeAnthropicOAuthStatus } from "../../src/provider/contract.js";
import { TuiAnthropicLogin } from "../../src/tui/features/auth/anthropic-login.js";
import { stripAnsi, visibleWidth } from "../../src/tui/rendering/text.js";

const disconnected: McodeAnthropicOAuthStatus = {
  state: "disconnected",
  providerId: "anthropic",
};
const pending: McodeAnthropicOAuthStatus = {
  state: "pending",
  providerId: "anthropic",
  loginId: "attempt-1",
  authUrl: "https://claude.ai/oauth/authorize?state=test",
};

function harness(initial = disconnected) {
  const application = {
    getAnthropicOAuthStatus: vi.fn(
      async (): Promise<McodeAnthropicOAuthStatus> => initial,
    ),
    connectAnthropicOAuth: vi.fn(
      async (): Promise<McodeAnthropicOAuthStatus> => pending,
    ),
    cancelAnthropicOAuthLogin: vi.fn(
      async (): Promise<McodeAnthropicOAuthStatus> => disconnected,
    ),
  };
  const openExternalTarget = vi.fn(async () => undefined);
  const onConnected = vi.fn();
  const onClose = vi.fn();
  const panel = new TuiAnthropicLogin({
    application,
    openExternalTarget,
    onConnected,
    onClose,
    requestRender: vi.fn(),
  });
  return {
    panel,
    application,
    openExternalTarget,
    onConnected,
    onClose,
    text: () => stripAnsi(panel.render(90).join("\n")),
  };
}

afterEach(() => vi.useRealTimers());

describe("Anthropic sign-in panel", () => {
  it("opens browser login and polls until connected", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.panel.resume();
    h.panel.handleInput("\r");
    await vi.advanceTimersByTimeAsync(0);

    expect(h.openExternalTarget).toHaveBeenCalledWith(pending.authUrl);
    expect(h.text()).toContain("Complete sign-in in your browser");
    h.application.getAnthropicOAuthStatus.mockResolvedValue({
      ...disconnected,
      state: "connected",
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.onConnected).toHaveBeenCalledOnce();
    h.panel.dispose();
  });

  it("resumes and cancels a pending callback login", async () => {
    const h = harness(pending);
    await h.panel.resume();
    expect(h.application.connectAnthropicOAuth).not.toHaveBeenCalled();
    expect(h.text()).toContain(pending.authUrl);
    h.panel.handleInput("\u001b");
    await vi.waitFor(() => expect(h.onClose).toHaveBeenCalledOnce());
    expect(h.application.cancelAnthropicOAuthLogin).toHaveBeenCalledWith("attempt-1");
    h.panel.dispose();
  });

  it("keeps the authorization URL and cancel action visible in a narrow terminal", async () => {
    const h = harness(pending);
    await h.panel.resume();
    const rows = h.panel.renderViewport(40, 12);
    const text = stripAnsi(rows.join("\n"));
    expect(text).toContain("claude.ai/oauth/authorize");
    expect(text).toContain("Esc cancel");
    expect(rows.every((row) => visibleWidth(row) <= 40)).toBe(true);
    expect(rows.length).toBeLessThanOrEqual(12);
    h.panel.dispose();
  });
});
