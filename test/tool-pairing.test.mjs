// 上游（CC/Anthropic）硬性要求 tool_result 紧跟 tool_use：被中断/取消的历史会留下
// 无人应答的 tool-call，之后整条会话的每次请求都被上游 400 拒绝：
//   "Tool result is missing for tool call call_01_..."
// 这里覆盖请求构造层（buildCcRequest，三条协议共用）的配对修复：
// 缺 result 的补占位、错位的移回；正常历史零改动。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

const AUTH = { Authorization: 'Bearer user_test' };
const wire = (s) => s.mock.lastGenerate().body.params.messages;
const toolResultsOf = (m) => (Array.isArray(m.content) ? m.content.filter(c => c.type === 'tool-result') : []);

test('responses：被中断的 tool_call（无 output）自动补占位 tool-result', async () => {
  const s = await setup();
  try {
    await s.proxy.post('/v1/responses', {
      model: 'm',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '跑一下工具' }] },
        { type: 'function_call', call_id: 'call_x', name: 'shell', arguments: '{}' },
        // 用户中断：没有 function_call_output，下一轮直接是新的 user 消息
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '算了' }] },
      ],
    }, AUTH);
    const msgs = wire(s);
    assert.equal(msgs.map(m => m.role).join(','), 'user,assistant,tool,user',
      '占位 tool-result 必须紧跟 assistant，不能把后续 user 消息夹在中间');
    const result = toolResultsOf(msgs[2])[0];
    assert.equal(result.toolCallId, 'call_x');
    assert.equal(result.toolName, 'shell');
    assert.match(result.output.value, /missing/i, '占位内容要让模型知道这次调用没有被执行');
  } finally { await s.close(); }
});

test('responses：并行调用只回了一半 output → 缺的补占位，已有结果不动', async () => {
  const s = await setup();
  try {
    await s.proxy.post('/v1/responses', {
      model: 'm',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '并行两个' }] },
        { type: 'function_call', call_id: 'call_a', name: 'shell', arguments: '{}' },
        { type: 'function_call', call_id: 'call_b', name: 'shell', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_a', output: 'done A' },
      ],
    }, AUTH);
    const msgs = wire(s);
    assert.equal(msgs.map(m => m.role).join(','), 'user,assistant,tool,tool',
      '两条 tool-result 必须相邻跟在 assistant 之后');
    const results = msgs.filter(m => m.role === 'tool').flatMap(toolResultsOf);
    assert.deepEqual(results.map(r => r.toolCallId), ['call_a', 'call_b']);
    assert.equal(results[0].output.value, 'done A', '真实结果原样保留');
    assert.match(results[1].output.value, /missing/i);
  } finally { await s.close(); }
});

test('chat：assistant.tool_calls 没有对应 tool 消息 → 同样补占位', async () => {
  const s = await setup();
  try {
    await s.proxy.post('/v1/chat/completions', {
      model: 'm',
      messages: [
        { role: 'user', content: '跑' },
        { role: 'assistant', content: null,
          tool_calls: [{ id: 'call_c', type: 'function', function: { name: 'shell', arguments: '{}' } }] },
        { role: 'user', content: '算了换个问题' },
      ],
    }, AUTH);
    const msgs = wire(s);
    assert.equal(msgs.map(m => m.role).join(','), 'user,assistant,tool,user');
    const result = toolResultsOf(msgs[2])[0];
    assert.equal(result.toolCallId, 'call_c');
    assert.equal(result.toolName, 'shell');
  } finally { await s.close(); }
});

test('历史配对完好时完全不动（回归）', async () => {
  const s = await setup();
  try {
    await s.proxy.post('/v1/chat/completions', {
      model: 'm',
      messages: [
        { role: 'user', content: '跑' },
        { role: 'assistant', content: null,
          tool_calls: [{ id: 'call_d', type: 'function', function: { name: 'shell', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_d', content: 'ok' },
      ],
    }, AUTH);
    const msgs = wire(s);
    assert.equal(msgs.map(m => m.role).join(','), 'user,assistant,tool',
      '配对完好时不得多插任何消息');
    assert.equal(toolResultsOf(msgs[2])[0].output.value, 'ok');
  } finally { await s.close(); }
});
