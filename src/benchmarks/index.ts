import type { BenchmarkCatalogEntry } from './types.js';
import { chatbotSuite } from './suites/chatbot.js';
import { crmSuite } from './suites/crm.js';
import { polymarketSuite } from './suites/polymarket.js';
import { teamAssistantSuite } from './suites/team-assistant.js';

export const benchmarkCatalog: BenchmarkCatalogEntry[] = [
  { id: 'polymarket', fileStem: 'polymarket-arb', aliases: ['polymarket-arb'], suite: polymarketSuite },
  { id: 'crm', fileStem: 'crm', suite: crmSuite },
  { id: 'chatbot', fileStem: 'chatbot', suite: chatbotSuite },
  { id: 'team-assistant', fileStem: 'team-assistant', suite: teamAssistantSuite },
];

export const findBenchmark = (name: string) => benchmarkCatalog.find(entry => [entry.id, entry.fileStem, ...(entry.aliases ?? [])].includes(name));
