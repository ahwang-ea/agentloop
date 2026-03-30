import { emptyWarmSession, pickWarmSession, recordWarmSession } from '../session-budget.js';

const config = { maxTasksPerSession: 3, maxTokensPerSession: 100000 };
const session = { id: 's1', taskId: 't1' };

test('reuses warm sessions only for the same feature', () => {
  const state = recordWarmSession(emptyWarmSession(), 'orders', session, 100, config);
  expect(pickWarmSession(state, 'orders')).toEqual(session);
  expect(pickWarmSession(state, 'billing')).toBeUndefined();
  expect(pickWarmSession(state, undefined)).toBeUndefined();
});

test('clears the session after the task cap is reached', () => {
  let state = recordWarmSession(emptyWarmSession(), 'orders', session, 10, config);
  state = recordWarmSession(state, 'orders', session, 10, config);
  state = recordWarmSession(state, 'orders', session, 10, config);
  expect(state).toEqual(emptyWarmSession());
});

test('clears the session after the token cap is reached', () => {
  const state = recordWarmSession(emptyWarmSession(), 'orders', session, 100000, config);
  expect(state).toEqual(emptyWarmSession());
});
