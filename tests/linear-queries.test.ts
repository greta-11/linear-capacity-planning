import { describe, expect, it } from 'vitest';
import { QUERIES } from '../server/linear/queries';
import { BUDGET, estimateComplexity, LIMIT } from './complexity';

describe('Linear query complexity', () => {
  it('matches what Linear reported for the old nested teams + members query', () => {
    const old = `query Teams($after: String) {
      teams(first: 50, after: $after) {
        nodes {
          id key name cyclesEnabled cycleDuration issueEstimationType timezone
          members(first: 250) { nodes { id name displayName email avatarUrl active } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`;
    // Linear's error: "The query is too complex. Complexity: 20145. Maximum allowed complexity: 10000."
    const estimate = estimateComplexity(old);
    expect(Math.abs(estimate - 20145) / 20145).toBeLessThan(0.01);
    expect(estimate).toBeGreaterThan(LIMIT);
  });

  for (const [name, query] of Object.entries(QUERIES)) {
    it(`${name} stays within half of Linear's per-query limit`, () => {
      expect(estimateComplexity(query)).toBeLessThanOrEqual(BUDGET);
    });
  }
});
