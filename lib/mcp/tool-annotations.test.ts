import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';

import { withToolAnnotations } from './tool-annotations';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

interface Registered {
  config: {
    title?: string;
    inputSchema: Record<string, unknown>;
    annotations?: Record<string, unknown>;
  };
  handler: (args: Record<string, unknown>, extra: unknown) => unknown;
}

function fakeServer() {
  const registered = new Map<string, Registered>();
  const server = {
    registerTool: (name: string, config: Registered['config'], handler: Registered['handler']) => {
      registered.set(name, { config, handler });
    },
  };
  return { server: server as unknown as McpServer, registered };
}

test('shared params are advertised on every tool and stripped before the handler', async () => {
  const { server, registered } = fakeServer();
  const wrapped = withToolAnnotations(server, { site_id: z.string().optional() });

  let received: Record<string, unknown> | null = null;
  wrapped.tool('update_page', 'Update a page', { page_id: z.string() }, async (args: Record<string, unknown>) => {
    received = args;
    return { content: [] };
  });

  const tool = registered.get('update_page')!;
  assert.deepEqual(Object.keys(tool.config.inputSchema).sort(), ['page_id', 'site_id']);

  await tool.handler({ page_id: 'p1', site_id: 's1' }, {});
  assert.deepEqual(received, { page_id: 'p1' });
});

test('title is set both on the tool and in annotations', () => {
  const { server, registered } = fakeServer();
  withToolAnnotations(server).tool('delete_page', 'Delete a page', {}, async () => ({ content: [] }));

  const { config } = registered.get('delete_page')!;
  assert.equal(config.title, 'Delete page');
  assert.equal(config.annotations?.title, 'Delete page');
  assert.equal(config.annotations?.destructiveHint, true);
});

test('without shared params the schema and handler pass through untouched', () => {
  const { server, registered } = fakeServer();
  const handler = async () => ({ content: [] });
  withToolAnnotations(server).tool('list_pages', 'List pages', {}, handler);

  assert.equal(registered.get('list_pages')!.handler, handler);
  assert.deepEqual(registered.get('list_pages')!.config.inputSchema, {});
});
