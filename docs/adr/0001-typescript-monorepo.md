# ADR 0001: TypeScript monorepo (NestJS + React), pnpm + Turborepo

- Status: Accepted
- Date: 2026-09-30

## Context
We need a server–client finance app with several deployable services (API, worker, web, MCP)
that share types and business logic. The maintainer prefers TypeScript end to end.

## Decision
- A single repo with pnpm workspaces and Turborepo for task orchestration and caching.
- The API and worker use **NestJS 11 on the Fastify adapter**. NestJS provides modules, DI,
  guards, and testing utilities, and Fastify provides throughput and schema-based validation.
- The web client uses **React + Vite + TypeScript**.
- Contracts are **zod** schemas in `packages/shared`, used for API validation, OpenAPI
  generation, and client typing.
- The runtime is **Node 22 LTS**, pinned via `.nvmrc` and `engines`.

## Consequences
- One language and one toolchain, with shared types and no codegen drift.
- The worker and API share `packages/domain`, which keeps business rules in one place.
- NestJS adds boilerplate. We accept that in exchange for structure over a long-lived codebase.
