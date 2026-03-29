// core/codex.ts — OpenAI adapter for detail review.

import OpenAI from 'openai';
import { err, type Result } from '../shared/result.js';
import type { CodexAdapter, ReviewResult } from '../types/index.js';
import { buildReviewPrompt, parseReviewOutput } from './review-output.js';

export function createCodexAdapter(apiKey: string, model: string): CodexAdapter {
  const client = new OpenAI({ apiKey });
  return {
    async review(request): Promise<Result<ReviewResult>> {
      const started = Date.now();
      try {
        const response = await client.chat.completions.create({
          model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'developer', content: 'Return only valid JSON. Do not wrap it in markdown.' },
            { role: 'user', content: buildReviewPrompt(request) },
          ],
        });
        const rawOutput = response.choices[0]?.message?.content ?? '';
        if (!rawOutput.trim()) return err('EMPTY_RESPONSE', `Codex review returned no content for ${request.role}`);
        return parseReviewOutput(rawOutput, request.role, (Date.now() - started) / 1000);
      } catch (e) {
        return err('TRANSPORT_ERROR', `Codex review failed: ${e instanceof Error ? e.message : 'unknown error'}`);
      }
    },
  };
}
