import type { MetricsRecord } from '../types/index.js';

export interface BenchmarkSuite {
  name: string;
  goal: string;
  maxTimeSec: number;
  baseDeps?: string[];
  architectureNotes?: string;
  goldenTestFile?: string;
  acceptanceTests: AcceptanceTest[];
}
export type AcceptanceTest =
  | { type: 'command'; name: string; cmd: string; args: string[]; timeoutMs?: number; expectExitCode?: number }
  | { type: 'file-exists'; name: string; paths: string[] }
  | { type: 'file-contains-substring'; name: string; dir: string; extensions: string[]; substring: string }
  | { type: 'file-contains-regex'; name: string; dir: string; extensions: string[]; regex: string }
  | { type: 'min-file-count'; name: string; dir: string; extension: string; min: number };

export interface BenchmarkFirstPass {
  definition: string;
  successes: number;
  consideredTasks: number;
}

export interface BenchmarkRunMetadata {
  mode: 'benchmark-fast-path';
  depcheckSkipped: boolean;
  reviewEnabled: boolean;
  sweepEnabled: boolean;
  useCodexWriter: boolean;
  models: { claude: string; codex: string };
  runtime: { node: string; platform: string; arch: string };
}

export interface BenchmarkResult {
  version?: 2;
  suite: string;
  timestamp: string;
  duration: number;
  tasksTotal: number;
  tasksCompleted: number;
  tasksStuck: number;
  avgRounds: number;
  avgTimeSec: number;
  firstPassRate: number;
  firstPass?: BenchmarkFirstPass;
  acceptanceTests: { name: string; passed: boolean; output?: string }[];
  score: number;
  metricsSnapshot: MetricsRecord[];
  runMetadata?: BenchmarkRunMetadata;
}
export interface BenchmarkCatalogEntry { id: string; fileStem: string; suite: BenchmarkSuite; aliases?: string[]; }
