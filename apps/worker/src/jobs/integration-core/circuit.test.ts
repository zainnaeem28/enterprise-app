import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CircuitBreakers, type CircuitState } from './circuit.js';

const make = () => {
  let t = 1_000_000;
  const transitions: string[] = [];
  const c = new CircuitBreakers({
    now: () => t,
    onTransition: (_id, from, to) => transitions.push(`${from}>${to}`),
  });
  return { c, transitions, tick: (ms: number) => (t += ms) };
};

describe('circuit state (34.2)', () => {
  test('opens after 5 consecutive failures, and not after 4', () => {
    const { c } = make();
    for (let i = 0; i < 4; i++) {
      assert.ok(c.admit('a'));
      c.record('a', false);
    }
    assert.equal(c.state('a'), 'closed');
    assert.ok(c.admit('a'));
    c.record('a', false);
    assert.equal(c.state('a'), 'open');
    assert.equal(c.admit('a'), false, 'an open circuit fails fast');
  });

  test('a success resets the consecutive count', () => {
    const { c } = make();
    for (let i = 0; i < 4; i++) c.record('a', false);
    c.record('a', true);
    for (let i = 0; i < 4; i++) c.record('a', false);
    assert.equal(c.state('a'), 'closed');
  });

  test('opens at 50 % errors over 20 calls inside one minute', () => {
    const { c } = make();
    // alternate so the consecutive rule never fires: 10 failures + 10 successes = 50 %
    for (let i = 0; i < 20; i++) c.record('a', i % 2 === 0 ? false : true);
    assert.equal(c.state('a'), 'open');
  });

  test('49 % over 20 calls stays closed; 19 calls are not enough to judge', () => {
    const { c } = make();
    for (let i = 0; i < 19; i++) c.record('a', i % 2 === 0 ? false : true);
    assert.equal(c.state('a'), 'closed');
    const d = make();
    const pattern = [
      false,
      true,
      true,
      false,
      true,
      true,
      false,
      true,
      true,
      false,
      true,
      true,
      false,
      true,
      true,
      false,
      true,
      true,
      true,
      true,
    ];
    for (const ok of pattern) d.c.record('b', ok);
    assert.equal(d.c.state('b'), 'closed'); // 6 failures of 20
  });

  test('calls older than a minute leave the window', () => {
    const { c, tick } = make();
    for (let i = 0; i < 10; i++) c.record('a', i % 2 === 0 ? false : true);
    tick(61_000);
    for (let i = 0; i < 10; i++) c.record('a', i % 2 === 0 ? false : true);
    assert.equal(c.state('a'), 'closed', 'only 10 calls are inside the window');
  });

  test('half-open after 30 s admits exactly one probe; success closes', () => {
    const { c, tick, transitions } = make();
    for (let i = 0; i < 5; i++) c.record('a', false);
    tick(29_999);
    assert.equal(c.admit('a'), false);
    tick(1);
    assert.equal(c.state('a'), 'half_open');
    assert.ok(c.admit('a'), 'the probe');
    assert.equal(c.admit('a'), false, 'a second call during the probe is refused');
    c.record('a', true);
    assert.equal(c.state('a'), 'closed');
    assert.ok(c.admit('a'));
    assert.deepEqual(transitions, ['closed>open', 'open>half_open', 'half_open>closed']);
  });

  test('a failed probe re-opens for another 30 s', () => {
    const { c, tick } = make();
    for (let i = 0; i < 5; i++) c.record('a', false);
    tick(30_000);
    assert.ok(c.admit('a'));
    c.record('a', false);
    assert.equal(c.state('a') as CircuitState, 'open');
    tick(29_000);
    assert.equal(c.admit('a'), false);
    tick(1_000);
    assert.ok(c.admit('a'));
  });

  test('a released probe slot (vendor 4xx) lets the next call probe', () => {
    const { c, tick } = make();
    for (let i = 0; i < 5; i++) c.record('a', false);
    tick(30_000);
    assert.ok(c.admit('a'));
    c.release('a');
    assert.ok(c.admit('a'));
  });

  test('state is per connection', () => {
    const { c } = make();
    for (let i = 0; i < 5; i++) c.record('a', false);
    assert.ok(c.admit('b'));
  });
});
