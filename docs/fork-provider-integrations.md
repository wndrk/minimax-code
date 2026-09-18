# Fork provider integrations

This fork keeps provider-specific authentication behind Runtime V2's model-system boundary. It does
not change the generic OpenAI/Anthropic-compatible BYOK path.

## OAuth providers

Enable the desired entries in the active profile's `config.yaml`:

```yaml
beta:
  anthropicOAuth: true
  codexOAuth: true
```

Then run `mcode`, open `/provider`, and select **Anthropic** or **OpenAI Codex**.

- Anthropic uses Pi's Claude Pro/Max OAuth implementation and a loopback callback on port `53692`.
  The browser must run on the same machine as `mcode`. Successful login creates a read-only
  `custom_provider:anthropic` catalog from Pi's bundled Anthropic model metadata.
- OpenAI Codex uses Pi's browser or device-code login. Its existing model-discovery client fetches
  the account's available Codex models after authentication.
- Both providers store refreshable credentials in `<dataDir>/codex-auth.json`, Pi's existing OAuth
  credential store. Provider/model configuration remains in `config.yaml`. Tokens are never copied
  into provider configuration.

OAuth is opt-in in public production builds. Development builds enable both switches by default.

## Z.ai GLM Coding Plan

No fork patch is required. The vendored Pi catalog and the existing provider-preset path already
support both Coding Plan regions:

- International: `zai`, `https://api.z.ai/api/coding/paas/v4`
- China: `zai-coding-cn`, `https://open.bigmodel.cn/api/coding/paas/v4`

The catalog includes current GLM models, Z.ai thinking format, tool-stream compatibility, and the
corresponding `ZAI_API_KEY` / `ZAI_CODING_CN_API_KEY` environment-key conventions. In the TUI, add
the pinned **Z.AI Coding Plan** preset from `/provider` and enter the plan API key.

## Keeping the fork current

The fork-specific surface is intentionally limited to:

1. `anthropic-oauth.ts`, composed next to the pre-existing `codex-oauth.ts` manager;
2. process-local provider capability methods and thin TUI adapters;
3. one Anthropic login panel and provider-manager row;
4. beta-feature declarations and this document.

For an upstream update:

```bash
git fetch upstream
git rebase upstream/main
pnpm install --frozen-lockfile
pnpm verify
```

Resolve provider conflicts by preserving upstream's model-system contracts first, then reapply the
small manager/composition adapters. Do not fork generated model catalogs: take upstream Pi catalog
updates so Codex, Anthropic, and Z.ai model metadata continue to advance together. If upstream gains
equivalent Anthropic OAuth UI support, drop the fork's manager and adapters in one commit while
retaining any still-needed public-build opt-in fix. Regenerate `release/public-source.json` after
adding or removing files, as required by this repository's source-sync contract.
