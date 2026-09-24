import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { McpServer as AcpMcpServer } from '@agentclientprotocol/sdk';
import type { ToolEntry, ToolResultValue } from '@opencode/ai';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';

export const toolError = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });

export function toolResult(value: ToolResultValue): CallToolResult {
  if (value.type !== 'content') return { isError: value.type === 'error', content: [{ type: 'text',
    text: typeof value.value === 'string' ? value.value : JSON.stringify(value.value) ?? '' }] };
  return { content: value.value.map((part) => {
    if (part.type === 'text') return part;
    const image = /^data:(image\/(?:png|jpeg|gif|webp));base64,([\s\S]*)$/.exec(part.uri);
    if (image) return { type: 'image' as const, mimeType: image[1]!, data: image[2]! };
    return { type: 'resource_link' as const, uri: part.uri, name: part.name ?? part.uri, mimeType: part.mime };
  }) };
}

/** A session-scoped MCP facade. Execution always returns to OpenCode's tool loop. */
export class ToolRelay {
  private readonly token = randomBytes(32).toString('hex');
  private tools: Tool[] = [];
  private readonly requests = new Set<Server>();
  private readonly http = createServer((req, res) => {
    void (async () => {
      if (req.url !== '/mcp' || req.headers.authorization !== `Bearer ${this.token}` || req.headers.origin) {
        res.writeHead(403).end(); return;
      }
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      const server = new Server({ name: 'opencode', version: '0.1.0' }, { capabilities: { tools: {} } });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      this.requests.add(server);
      res.on('close', () => { this.requests.delete(server); void server.close(); });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.tools }));
      server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        if (!this.tools.some((tool) => tool.name === params.name)) return toolError('Tool is unavailable in this OpenCode session.');
        return this.call(params.name, params.arguments ?? {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });

  constructor(readonly call: (name: string, input: unknown) => Promise<CallToolResult>) {}

  update(entries: readonly ToolEntry[]) {
    const flatten = (items: readonly ToolEntry[]): Tool[] => items.flatMap((item) => item.type === 'namespace'
      ? flatten(item.tools)
      : [{ name: item.name, description: item.description, inputSchema: { ...item.inputSchema, type: 'object' as const } }]);
    this.tools = flatten(entries);
  }

  async start(): Promise<AcpMcpServer> {
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(0, '127.0.0.1', () => { this.http.off('error', reject); resolve(); });
    });
    this.http.unref();
    const address = this.http.address();
    if (!address || typeof address === 'string') throw new Error('Unable to start OpenCode tool relay.');
    return { type: 'http', name: 'opencode', url: `http://127.0.0.1:${address.port}/mcp`,
      headers: [{ name: 'Authorization', value: `Bearer ${this.token}` }] };
  }

  close() {
    for (const request of this.requests) void request.close();
    this.requests.clear();
    this.http.closeAllConnections();
    this.http.close();
  }
}
