# ADR 0004: Pluggable providers (aggregation, market data, OCR, LLM, notifications)

- Status: Accepted
- Date: 2026-09-30

## Context
Plaid requires every self-hoster to have their own Plaid developer account. Production
access requires approval and may cost money. Many users will want free alternatives or no
external services at all.

## Decision
Define provider interfaces in `packages/domain` with multiple implementations:

| Concern | Interface | Implementations (planned) |
|---------|-----------|---------------------------|
| Bank aggregation | `AggregationProvider` | Plaid, SimpleFIN Bridge, file import (CSV/OFX/QFX) |
| Market prices | `PriceProvider` | Yahoo-compatible, Alpha Vantage, Finnhub, manual |
| OCR | `OcrProvider` | Tesseract (local), LLM vision |
| LLM | `LlmProvider` | Anthropic, OpenAI-compatible (Ollama, llama.cpp) |
| Notifications | `NotificationChannel` | SMTP email, ntfy, Gotify, webhook |
| Storage | `ObjectStorage` | Local disk, S3-compatible |

Providers are enabled by env and configuration, and the UI hides features whose provider is absent.

## Consequences
- More interfaces up front, but the app stays usable at zero cost and fully offline.
- The Plaid integration must follow Plaid's rules: link tokens, webhooks, `/transactions/sync`
  cursors, and encrypted access-token storage.
