import { parseReviewOutput } from '../review-output.js';
import type { ReviewerRole } from '../../types/index.js';

describe('parseReviewOutput', () => {
  let reviewer: ReviewerRole;
  let duration: number;

  beforeEach(() => {
    reviewer = 'opus-bigpicture';
    duration = 1.5;
  });

  test('parses valid JSON arrays, wrappers, and markdown code fences', () => {
    const array = parseReviewOutput('[{"severity":"issue","description":"Fix API shape","topicKey":"api-shape","action":"change"}]', reviewer, duration);
    const wrapper = parseReviewOutput('{"findings":[{"severity":"suggestion","description":"Document env var"}]}', reviewer, duration);
    const fenced = parseReviewOutput('```json\n[{"severity":"issue","description":"Rename helper","topicKey":"helper","action":"rename"}]\n```', reviewer, duration);
    expect(array.ok).toBe(true);
    expect(wrapper.ok).toBe(true);
    expect(fenced.ok).toBe(true);
    if (array.ok) expect(array.value.findings).toHaveLength(1);
    if (wrapper.ok) expect(wrapper.value.findings[0]?.severity).toBe('suggestion');
    if (fenced.ok) expect(fenced.value.findings[0]).toMatchObject({ action: 'rename', topicKey: 'helper' });
  });

  test('returns a clean result for empty findings', () => {
    const result = parseReviewOutput('{"findings":[]}', reviewer, duration);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.findings).toEqual([]);
  });

  test('returns an error when required issue fields are missing', () => {
    const result = parseReviewOutput('[{"severity":"issue","description":"Missing action"}]', reviewer, duration);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SESSION_ERROR');
  });

  test('returns an error for an invalid action', () => {
    const result = parseReviewOutput('[{"severity":"issue","description":"Bad action","topicKey":"bad","action":"invent"}]', reviewer, duration);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SESSION_ERROR');
  });
});
