import { describe, it, expect } from 'vitest';
import { withDeadline, JobTimeoutError } from '../src/main.js';

describe('withDeadline', () => {
  it('passes a result through when the work finishes in time', async () => {
    await expect(withDeadline(Promise.resolve(42), 1000, 'derive')).resolves.toBe(42);
  });
  it('rejects with JobTimeoutError when the work hangs, so the slot is freed', async () => {
    const hang = new Promise<never>(() => {});
    await expect(withDeadline(hang, 20, 'derive')).rejects.toBeInstanceOf(JobTimeoutError);
  });
});
