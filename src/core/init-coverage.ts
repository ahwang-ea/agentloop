import OpenAI from 'openai';
import { err, ok, type Result } from '../shared/result.js';
import { asNumber, asObject, asString, asStringArray, parseJson } from './persisted-json.js';
import type { RepoInventory } from '../types/index.js';
import type { InitDraftBundle } from './init-drafts.js';
import { DEFAULT_CONFIG } from './cli-config.js';

export interface InitCoverage { covered: number; total: number; summary: string; missing: string[]; }

export async function checkInitCoverage(inventory: RepoInventory, drafts: InitDraftBundle): Promise<Result<InitCoverage>> {
  if (!process.env.OPENAI_API_KEY) return err('CONFIG_ERROR', 'OPENAI_API_KEY is required for smart init coverage checks');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  try {
    const response = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? DEFAULT_CONFIG.codexModel,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'developer', content: 'Return only valid JSON.' },
        { role: 'user', content: [
          'Check this init draft against the inventory with a coverage checklist.',
          'Checklist: every package referenced, best example file per package identified, every file over 300 lines mentioned, every env var documented, every competing pattern resolved or flagged as a question.',
          'Return JSON: {"covered":42,"total":45,"missing":["..."],"summary":"42/45 items covered."}',
          '', 'inventory.json:', JSON.stringify(inventory, null, 2),
          '', 'drafts:', JSON.stringify(drafts),
        ].join('\n') },
      ],
    });
    const raw = response.choices[0]?.message?.content ?? '';
    if (!raw.trim()) return err('EMPTY_RESPONSE', 'Init coverage returned no content');
    const parsed = parseJson(raw, 'init coverage response'); if (!parsed.ok) return err('TRANSPORT_ERROR', `Init coverage failed: ${parsed.error.message}`);
    const body = asObject(parsed.value); if (!body) return err('TRANSPORT_ERROR', 'Init coverage failed: response must be an object');
    const missing = (asStringArray(body.missing) ?? []).filter(item => item.trim());
    const covered = asNumber(body.covered) ?? 0;
    const total = asNumber(body.total) ?? (covered + missing.length);
    const summary = asString(body.summary)?.trim() ? asString(body.summary)! : `${covered}/${total} items covered.`;
    return ok({ covered, total, summary, missing });
  } catch (e) {
    return err('TRANSPORT_ERROR', `Init coverage failed: ${e instanceof Error ? e.message : 'unknown error'}`);
  }
}
