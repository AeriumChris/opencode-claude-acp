// An actual stdio ACP peer: deterministic fixture only, never used by the plugin.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

let sessionId;
let servers = [];
let model = 'fixture-model';
let effort = 'default';
let nextID = 1000;
let turns = 0;
const pending = new Map();
const prompts = new Map();
const log = (entry) => process.env.ACP_TEST_LOG && appendFileSync(process.env.ACP_TEST_LOG, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const result = (id, value) => send({ id, result: value });
const update = (value) => send({ method: 'session/update', params: { sessionId, update: value } });
const levels = () => model === 'fixture-no-effort' ? [] : model === 'fixture-other' ? ['default', 'low', 'max'] : ['default', 'low', 'medium', 'high'];
const config = () => [{ id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: model,
  options: [{ value: 'fixture-model', name: 'Fixture Claude' }, { value: 'fixture-other', name: 'Other fixture model' },
    { value: 'fixture-no-effort', name: 'No effort fixture' }] },
  ...(levels().length ? [{ id: 'thinking-budget', name: 'Effort', type: 'select', category: 'thought_level', currentValue: effort,
    options: [{ group: 'supported', name: 'Supported', options: levels().map((value) => ({ value, name: value })) }] }] : [])];
async function handle(message) {
  const { id, method, params = {} } = message;
  if (!method) { pending.get(id)?.(message.result); pending.delete(id); return; }
  log({ method, params });
  if (method === 'initialize') return result(id, { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, mcpCapabilities: { http: true } } });
  if (method === 'session/new') { servers = params.mcpServers; sessionId = randomUUID(); return result(id, { sessionId, configOptions: config() }); }
  if (method === 'session/load') { servers = params.mcpServers; sessionId = params.sessionId; return result(id, { configOptions: config() }); }
  if (method === 'session/set_config_option') {
    if (params.configId === 'model') { model = params.value; if (!levels().includes(effort)) effort = 'default'; }
    else if (params.configId === 'thinking-budget' && levels().includes(params.value)) effort = params.value;
    else return send({ id, error: { code: -32602, message: 'Unsupported effort' } });
    return result(id, { configOptions: config() });
  }
  if (method === 'session/cancel') {
    for (const [promptID] of prompts) result(promptID, { stopReason: 'cancelled' });
    prompts.clear();
    return;
  }
  if (method === 'session/prompt') {
    turns++;
    const usageUpdate = () => process.env.ACP_TEST_USAGE && update({ sessionUpdate: 'usage_update', used: 1000,
      size: model === 'fixture-other' ? 500000 : 1000000, cost: { amount: turns * 0.25, currency: 'USD' } });
    usageUpdate();
    log({ effective: { sessionId, model, effort } });
    prompts.set(id, true);
    const text = params.prompt.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    if (text === 'hang') return;
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Fixture thinking.' } });
    if (text.startsWith('relay:')) {
      const server = servers.find((item) => item.name === 'opencode');
      const mcp = new Client({ name: 'acp-fixture', version: '1' });
      await mcp.connect(new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])) },
      }));
      try {
        log({ relayTools: (await mcp.listTools()).tools.map((tool) => tool.name) });
        const calls = JSON.parse(text.slice(6));
        const outputs = await Promise.all((Array.isArray(calls) ? calls : [calls]).map((call) => mcp.callTool(call)));
        log({ relayResults: outputs });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(outputs) } });
      } finally { await mcp.close(); }
    } else if (text.startsWith('permission')) {
      const requests = text.startsWith('permission:') ? JSON.parse(text.slice(11)) : [{}];
      await Promise.all(requests.map(async (request) => {
        const toolCallId = randomUUID();
        const requestID = nextID++;
        const options = request.options ?? [{ optionId: 'yes', kind: 'allow_once', name: 'Allow once' }, { optionId: 'no', kind: 'reject_once', name: 'Deny' }];
        const response = await new Promise((resolve) => {
          pending.set(requestID, resolve);
          send({ id: requestID, method: 'session/request_permission', params: { sessionId,
            toolCall: { toolCallId, title: 'Write fixture.txt', kind: 'edit', rawInput: { path: 'fixture.txt' }, ...request.toolCall },
            options,
          } });
        });
        log({ sessionId, permissionResult: response });
        if (!prompts.has(id)) return;
        const approved = response.outcome.outcome === 'selected' && options.some((option) =>
          option.optionId === response.outcome.optionId && ['allow_once', 'allow_always'].includes(option.kind));
        update({ sessionUpdate: 'tool_call_update', toolCallId, title: 'Write fixture.txt', status: approved ? 'completed' : 'failed', rawOutput: approved ? 'written' : 'denied' });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: approved ? 'Approved operation completed.' : 'Operation denied.' } });
      }));
    } else update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `fixture:${text}` } });
    prompts.delete(id);
    usageUpdate(); // Cumulative readings are snapshots, not increments.
    result(id, { stopReason: 'end_turn', ...(process.env.ACP_TEST_USAGE ? { usage: {
      inputTokens: 11, outputTokens: 7, cachedReadTokens: 23, cachedWriteTokens: 5, thoughtTokens: 3, totalTokens: 46,
    } } : {}) });
    return;
  }
  if (id !== undefined) send({ id, error: { code: -32601, message: `Unknown method: ${method}` } });
}
for await (const line of createInterface({ input: process.stdin })) {
  void handle(JSON.parse(line)).catch((error) => { console.error(error); process.exitCode = 1; });
}
