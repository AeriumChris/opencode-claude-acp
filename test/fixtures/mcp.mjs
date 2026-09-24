import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const server = new Server({ name: 'upstream-fixture', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', description: 'Echo with a server-only token',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({ content: [{ type: 'text',
  text: `${process.env.FIXTURE_TOKEN}:${params.arguments.text}` }] }));
await server.connect(new StdioServerTransport());
