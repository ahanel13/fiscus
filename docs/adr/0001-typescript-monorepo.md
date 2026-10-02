# ADR 0001: TypeScript monorepo (NestJS + React), pnpm + Turborepo

- Status: Accepted
- Date: 2026-09-30

## Context
We need a server–client finance app with several deployable services (API, worker, web, MCP)
that share types and business logic. The maintainer prefers TypeScript end to end.

## Decision
- A single repo with pnpm workspaces and Turborepo for task orchestration and caching.
- The API and worker use **NestJS 12 on the Fastify adapter**. NestJS provides modules, DI,
  guards, and testing utilities, and Fastify provides throughput and schema-based validation.
- The web client uses **React + Vite + TypeScript**.
- Contracts are **zod** schemas in `packages/shared`, used for API validation, OpenAPI
  generation, and client typing.
- The runtime is **Node 24 LTS**, pinned via `.nvmrc` and `engines`.
- **TypeScript 6.0** with ESM (`NodeNext`) everywhere. Node services emit decorator metadata for
  Nest's DI; their tests compile with SWC because esbuild can't emit it.
- Dependency versions live in one pnpm **catalog** (`pnpm-workspace.yaml`). Installs only accept
  versions **published at least 7 days ago** (`minimumReleaseAge`), and dependency build scripts
  run only when allow-listed (`allowBuilds`).

*Revised 2026-10-01 (#6): Node 22 → 24 (Node 24 is the active LTS; Node 22 reaches end of life in April 2027),
NestJS 11 → 12, and TypeScript pinned to 6.0 until `typescript-eslint` supports TypeScript 7.*

## Consequences
- One language and one toolchain, with shared types and no codegen drift.
- The worker and API share `packages/domain`, which keeps business rules in one place.
- NestJS adds boilerplate. We accept that in exchange for structure over a long-lived codebase.
