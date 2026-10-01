# Fiscus

> *fiscus* (Latin): the household money-basket; the root of "fiscal".

Fiscus is a self-hosted, open-source personal finance platform for households and couples.
It covers bank sync, flexible budgeting (zero-based, 50/30/20, flex, per-category),
his / hers / ours shared finances with settle-up, bills, goals, investments, forecasting and
FIRE planning, AI receipt scanning, reporting, notifications, and an optional AI assistant and
MCP server that can run on a local model.

**Status:** planning. Nothing to install yet.

- [Architecture](docs/architecture.md)
- [Roadmap & backlog](docs/roadmap.md)
- [Monarch feature parity](docs/monarch-parity.md)
- [Architecture decision records](docs/adr/)
- [Contributing / workflow](CONTRIBUTING.md)

## Trust model
The operator of a Fiscus instance can technically access the data stored on it. Only join an
instance run by someone you'd trust with your bank statements, or run your own.
See [ADR 0005](docs/adr/0005-tenancy-and-trust-model.md).

## License
[AGPL-3.0-or-later](LICENSE). You may use, modify, and host Fiscus, including commercially,
but modified versions offered to users must publish their source.

Fiscus is an independent project and is not affiliated with Monarch Money.
