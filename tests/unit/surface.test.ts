import { test } from 'node:test';
import assert from 'node:assert/strict';

import { listSurface, listTurns, surfaceMessageIds } from '../../src/host/session/surface.ts';

/** Build a session double whose surface is the given seq order. */
function session(nodes: unknown[], events: Record<number, unknown>): unknown {
  return {
    surface: { nodes },
    eventAt: (seq: unknown) => events[seq as number],
  };
}

function userMessage(id: string | undefined, text: string): unknown {
  const message: Record<string, unknown> = { role: 'user', content: [{ type: 'text', text }] };
  if (id !== undefined) message['id'] = id;
  return { type: 'user/message', seq: 1, data: message };
}

function assistantMessage(id: string, text: string): unknown {
  return {
    type: 'assistant/message',
    seq: 2,
    data: { turn: 1, step: 1, message: { id, role: 'assistant', content: [{ type: 'text', text }] } },
  };
}

test('a non-session value projects to an empty list', () => {
  assert.deepEqual(listSurface(null), []);
  assert.deepEqual(listSurface(undefined), []);
  assert.deepEqual(listSurface('nope'), []);
  assert.deepEqual(listSurface({}), []);
  assert.deepEqual(listSurface({ surface: { nodes: 'not-an-array' } }), []);
});

test('user messages are read from the event payload directly, assistant messages from the nested field', () => {
  const projected = listSurface(
    session(
      [1, 2],
      {
        1: userMessage('u-1', 'hello there'),
        2: assistantMessage('a-1', 'general kenobi'),
      },
    ),
  );
  assert.deepEqual(projected, [
    { seq: 1, eventType: 'user/message', role: 'user', messageId: 'u-1', head: 'hello there' },
    { seq: 2, eventType: 'assistant/message', role: 'assistant', messageId: 'a-1', head: 'general kenobi' },
  ]);
});

test('log-only and boundary events are skipped so nothing unannotatable is offered', () => {
  const projected = listSurface(
    session(
      [1, 2, 3, 4, 5],
      {
        1: userMessage('u-1', 'kept'),
        2: { type: 'turn/start', seq: 2, data: { turn: 1 } },
        3: { type: 'compaction/summary', seq: 3, data: {} },
        4: { type: 'system/message', seq: 4, data: { message: { id: 's-1', role: 'system', content: [] } } },
        5: assistantMessage('a-1', 'also kept'),
      },
    ),
  );
  assert.deepEqual(
    projected.map((message) => message.messageId),
    ['u-1', 'a-1'],
  );
});

test('a tool result is included and its id extracted', () => {
  const toolResult = {
    type: 'tool/result',
    seq: 9,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 't-1',
        role: 'user',
        content: [{ type: 'tool-result', content: [{ type: 'text', text: 'command output' }] }],
      },
    },
  };
  const projected = listSurface(session([9], { 9: toolResult }));
  assert.equal(projected.length, 1);
  assert.equal(projected[0]?.eventType, 'tool/result');
  assert.equal(projected[0]?.messageId, 't-1');
  assert.equal(projected[0]?.head, 'command output');
});

test('a message without a durable id reports null rather than a placeholder', () => {
  const projected = listSurface(session([1], { 1: userMessage(undefined, 'no id here') }));
  assert.equal(projected[0]?.messageId, null);
});

test('the preview is truncated to the limit without splitting surrogate pairs', () => {
  const long = '\u{1F600}'.repeat(50);
  const projected = listSurface(session([1], { 1: userMessage('u-1', long) }), 10);
  assert.equal(projected[0]?.head.length, 10);
  for (const unit of projected[0]?.head ?? '') {
    const code = unit.codePointAt(0) ?? 0;
    assert.ok(code < 0xd800 || code > 0xdfff, 'no lone surrogate in the preview');
  }
});

test('a missing event for a surface node is skipped, not fatal', () => {
  const projected = listSurface(session([1, 2], { 1: userMessage('u-1', 'present') }));
  assert.equal(projected.length, 1);
});

test('surfaceMessageIds drops messages without ids', () => {
  const projected = listSurface(
    session([1, 2, 3], {
      1: userMessage('u-1', 'a'),
      2: userMessage(undefined, 'b'),
      3: assistantMessage('a-1', 'c'),
    }),
  );
  assert.deepEqual(surfaceMessageIds(projected), ['u-1', 'a-1']);
});

/** A session double that also reports its total event count, for turn scanning. */
function sessionWithLog(
  nodes: unknown[],
  events: Record<number, unknown>,
  total: number,
): unknown {
  return { surface: { nodes }, eventAt: (seq: unknown) => events[seq as number], seq: total };
}

function turnStart(seq: number): unknown {
  return { type: 'turn/start', seq };
}

function turnEnd(seq: number): unknown {
  return { type: 'turn/end', seq };
}

/** Surface message events keyed by their own seq. */
function userAt(seq: number, id: string, text: string): unknown {
  return { type: 'user/message', seq, data: { id, role: 'user', content: [{ type: 'text', text }] } };
}

function assistantAt(seq: number, id: string, text: string): unknown {
  return {
    type: 'assistant/message',
    seq,
    data: { turn: 1, step: 1, message: { id, role: 'assistant', content: [{ type: 'text', text }] } },
  };
}

function toolAt(seq: number, id: string, text: string): unknown {
  return {
    type: 'tool/result',
    seq,
    data: { message: { id, role: 'user', content: [{ type: 'tool-result', content: [{ type: 'text', text }] }] } },
  };
}

test('a non-session value projects to no turns', () => {
  assert.deepEqual(listTurns(null), []);
  assert.deepEqual(listTurns({}), []);
});

function twoTurnSession(): unknown {
  return sessionWithLog(
    [10, 11, 12, 30, 31],
    {
      2: turnStart(2),
      15: turnEnd(15),
      20: turnStart(20),
      35: turnEnd(35),
      10: userAt(10, 'u-1', 'first prompt'),
      11: assistantAt(11, 'a-1', 'first answer'),
      12: toolAt(12, 't-1', 'tool output'),
      30: userAt(30, 'u-2', 'second prompt'),
      31: assistantAt(31, 'a-2', 'second answer'),
    },
    40,
  );
}

test('surface messages are grouped by the session\'s own turn boundaries', () => {
  const turns = listTurns(twoTurnSession());

  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.id, 'turn:10');
  assert.deepEqual(
    turns[0]?.messages.map((message) => message.seq),
    [10, 11, 12],
  );
  assert.deepEqual(
    turns[1]?.messages.map((message) => message.seq),
    [30, 31],
  );
});

/**
 * The regression guard for the whole design: a user message injected inside a
 * turn must not split it. One measured session logged 56 user messages against
 * 45 turns for exactly this reason.
 */
test('an injected user message inside a turn does not split it', () => {
  const turns = listTurns(
    sessionWithLog(
      [10, 11, 12],
      {
        2: turnStart(2),
        20: turnEnd(20),
        10: userAt(10, 'u-1', 'prompt'),
        11: userAt(11, 'u-injected', 'injected context'),
        12: assistantAt(12, 'a-1', 'answer'),
      },
      30,
    ),
  );

  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.messages.length, 3);
});

test('an unterminated turn stays open rather than being dropped', () => {
  const turns = listTurns(
    sessionWithLog([10, 11], { 2: turnStart(2), 10: userAt(10, 'u-1', 'prompt'), 11: assistantAt(11, 'a-1', 'answer') }, 20),
  );

  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.endSeq, null);
  assert.equal(turns[0]?.messages.length, 2);
});

/**
 * A compaction checkpoint is appended outside any turn. Folding it into a
 * neighbouring turn would misattribute it to an exchange it was not part of.
 */
test('a surface message no turn encloses becomes its own group', () => {
  const turns = listTurns(
    sessionWithLog(
      [10, 11, 50],
      {
        2: turnStart(2),
        15: turnEnd(15),
        10: userAt(10, 'u-1', 'prompt'),
        11: assistantAt(11, 'a-1', 'answer'),
        50: userAt(50, 'u-checkpoint', 'This is an automatically generated checkpoint'),
      },
      60,
    ),
  );

  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.id, 'turn:10');
  assert.equal(turns[1]?.id, 'loose:50');
  assert.equal(turns[1]?.messages[0]?.messageId, 'u-checkpoint');
});
