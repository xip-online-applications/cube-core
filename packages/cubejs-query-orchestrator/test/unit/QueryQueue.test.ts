import { QueuePriority } from '@cubejs-backend/base-driver';

import { queuePriorityTag } from '../../src/orchestrator/QueryQueue';
import { QueryQueueTest } from './QueryQueue.abstract';

QueryQueueTest('Local', {
  cacheAndQueueDriver: 'memory',
});

describe('queuePriorityTag', () => {
  test('maps each rung to its tag', () => {
    expect(queuePriorityTag(QueuePriority.Interactive)).toBe('interactive');
    expect(queuePriorityTag(QueuePriority.Warmup)).toBe('warmup');
    expect(queuePriorityTag(QueuePriority.Background)).toBe('background');
    expect(queuePriorityTag(QueuePriority.Scheduled)).toBe('scheduled');
  });

  test('maps a priority between rungs to the rung below it', () => {
    expect(queuePriorityTag(10000)).toBe('interactive');
    expect(queuePriorityTag(5)).toBe('warmup');
    expect(queuePriorityTag(-500)).toBe('scheduled');
  });

  test('tags a missing priority as unknown', () => {
    expect(queuePriorityTag(undefined)).toBe('unknown');
    expect(queuePriorityTag('10')).toBe('unknown');
    expect(queuePriorityTag(NaN)).toBe('unknown');
  });
});
