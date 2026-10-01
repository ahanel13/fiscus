#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// Tools are registered from packages/tools once the registry exists (ADR 0009).
const server = new McpServer({ name: 'fiscus', version: '0.0.0' });
await server.connect(new StdioServerTransport());
