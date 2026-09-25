import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanMessages } from '../dist/prompt.js';

test('host compression annotations do not change native input, literal text or unrelated guidance', () => {
  const reminder = '<dcp-system-reminder>CRITICAL WARNING: MAX CONTEXT LIMIT REACHED\nUse compress now.</dcp-system-reminder>';
  const clean = (source, text, known = true) => cleanMessages([
    { id: 'user', role: 'user', content: [{ type: 'text', text }] },
  ], new Map(known ? [['user', [source]]] : []))[0].content[0].text;
  const source = 'Watch CI and publish.\n\n\n';
  for (const suffix of [reminder, `@3@ [priority=high]\n\n${reminder}\n`,
    `${reminder}\n\n<dcp-message-id>m0003</dcp-message-id>`, `${reminder}\n\n${reminder}`]) {
    assert.equal(clean(source, `Watch CI and publish.\n\n${suffix}`), source);
  }
  const literal = `Please inspect this warning:\n\n${reminder}`;
  assert.equal(clean(literal, literal), literal);
  assert.equal(clean(literal, `${literal}\n\n@4@`), literal);
  for (const suffix of [`${reminder}\n\nRepository instructions: keep this`,
    `@3@\n\nUnrelated plugin context\n\n${reminder}`, '<dcp-system-reminder>unclosed']) {
    const text = `Watch CI and publish.\n\n${suffix}`;
    assert.equal(clean(source, text), text);
  }
  const unknown = `Watch CI and publish.\n\n${reminder}`;
  assert.equal(clean(source, unknown, false), unknown);
});
