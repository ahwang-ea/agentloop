import { ok, type Result } from '../shared/result.js';
import type { ConvergenceState, TaskDefinition, TaskState, TaskType } from '../types/index.js';
import { asBoolean, asNumber, asObject, asObjectArray, asString, asStringArray, malformed, parseJson, unwrapVersioned, type JsonMap } from './persisted-json.js';

type Lease = { token: string; expiresAt: string };
export type PersistedTaskRecord = TaskState & { claim?: Lease; dedupeKey?: string };
const status = new Set(['queued', 'writing', 'verifying', 'reviewing', 'fixing', 'cleanup', 'merging', 'finalizing', 'done', 'stuck', 'blocked']);
const priority = new Set(['low', 'medium', 'high']);
const taskType = new Set(['research', 'implement', 'integrate', 'debug']);
const classification = new Set(['converging', 'stuck', 'thrashing', 'unknown']);
const scopeOf = (value: unknown, path: string) => {
  const scope = asObject(value), editableFiles = scope && asStringArray(scope.editableFiles), readOnlyContext = scope && asStringArray(scope.readOnlyContext), forbiddenFiles = scope && asStringArray(scope.forbiddenFiles);
  return scope && editableFiles && readOnlyContext && forbiddenFiles ? ok({ editableFiles, readOnlyContext, forbiddenFiles }) : malformed<TaskDefinition['scope']>(path, 'invalid scope');
};
const taskOf = (value: JsonMap, path: string): Result<TaskDefinition> => {
  const task = asObject(value.task), scope = task && scopeOf(task.scope, path); if (!task || !scope?.ok) return scope?.ok === false ? scope : malformed(path, 'missing task');
  const id = asString(task.id), title = asString(task.title), description = asString(task.description), acceptanceCriteria = asStringArray(task.acceptanceCriteria), priorityValue = asString(task.priority), createdAt = asString(task.createdAt), rawType = task.type == null ? 'implement' : asString(task.type), dependsOn = task.dependsOn == null ? [] : asStringArray(task.dependsOn), feature = task.feature == null ? undefined : asString(task.feature);
  return id != null && title != null && description != null && acceptanceCriteria && priorityValue && priority.has(priorityValue) && createdAt != null && rawType && taskType.has(rawType) && dependsOn && (task.feature == null || feature != null)
    ? ok({ id, title, description, feature, type: rawType as TaskType, scope: scope.value, acceptanceCriteria, priority: priorityValue as TaskDefinition['priority'], dependsOn: dependsOn.length > 0 ? dependsOn : undefined, createdAt })
    : malformed(path, 'invalid task definition');
};
const convergenceOf = (value: unknown, path: string): Result<ConvergenceState> => {
  const state = asObject(value), rounds = state && asObjectArray(state.rounds), kind = state && asString(state.classification), web = state && asBoolean(state.webSearchTriggered), findings = state && asNumber(state.reviewFindings), errors = state && asStringArray(state.errorTypes), changed = state && asStringArray(state.changedFiles);
  if (!state || !rounds || !kind || !classification.has(kind) || web == null || findings == null || !errors || !changed) return malformed(path, 'invalid convergence');
  const normalized = [] as ConvergenceState['rounds'];
  for (const round of rounds) {
    const roundNumber = asNumber(round.round), issueCount = asNumber(round.issueCount), elapsed = asNumber(round.elapsed), tokens = asNumber(round.tokens), issueHashes = asStringArray(round.issueHashes);
    if (roundNumber == null || issueCount == null || elapsed == null || tokens == null || !issueHashes) return malformed(path, 'invalid convergence round');
    normalized.push({ round: roundNumber, issueCount, issueHashes, elapsed, tokens });
  }
  return ok({ rounds: normalized, classification: kind as ConvergenceState['classification'], webSearchTriggered: web, reviewFindings: findings, errorTypes: errors, changedFiles: changed });
};
const finalizationOf = (value: unknown, path: string) => {
  const state = asObject(value), mergeCommit = state && asString(state.mergeCommit), branch = state && asString(state.branch), mergeInto = state && asString(state.mergeInto), behaviorNotified = state && asBoolean(state.behaviorNotified), readmeTaskEnsured = state && asBoolean(state.readmeTaskEnsured), completionNotified = state && asBoolean(state.completionNotified), rebaseDone = state && asBoolean(state.rebaseDone), failCount = state && asNumber(state.failCount), featureBranch = state?.featureBranch == null ? undefined : asString(state.featureBranch), approvalRequested = state?.approvalRequested == null ? undefined : asBoolean(state.approvalRequested), approved = state?.approved == null ? undefined : asBoolean(state.approved), featureMerged = state?.featureMerged == null ? undefined : asBoolean(state.featureMerged), intentChecked = state?.intentChecked == null ? undefined : asBoolean(state.intentChecked);
  return state && mergeCommit != null && branch != null && mergeInto != null && behaviorNotified != null && readmeTaskEnsured != null && completionNotified != null && rebaseDone != null && failCount != null
    ? ok({ mergeCommit, branch, mergeInto, featureBranch, approvalRequested, approved, featureMerged, intentChecked, behaviorNotified, readmeTaskEnsured, completionNotified, rebaseDone, failCount })
    : malformed<TaskState['finalization']>(path, 'invalid finalization');
};
const blockedOf = (value: unknown, path: string) => {
  const state = asObject(value), reason = state && asString(state.reason), blockedAt = state && asString(state.blockedAt), details = state && asObject(state.details);
  return state && reason != null && blockedAt != null && details ? ok({ reason, blockedAt, details }) : malformed<TaskState['blocked']>(path, 'invalid blocked state');
};
const claimOf = (value: unknown, path: string) => {
  const claim = asObject(value), token = claim && asString(claim.token), expiresAt = claim && asString(claim.expiresAt);
  return claim && token != null && expiresAt != null ? ok({ token, expiresAt }) : malformed<Lease>(path, 'invalid claim');
};
const recordOf = (value: JsonMap, path: string): Result<PersistedTaskRecord> => {
  const task = taskOf(value, path); if (!task.ok) return task;
  const statusValue = asString(value.status), round = asNumber(value.round), startedAt = asString(value.startedAt), branch = value.branch == null ? undefined : asString(value.branch), stuckReason = value.stuckReason == null ? undefined : asString(value.stuckReason), completedAt = value.completedAt == null ? undefined : asString(value.completedAt), convergence = value.convergence == null ? ok(undefined) : convergenceOf(value.convergence, path), finalization = value.finalization == null ? ok(undefined) : finalizationOf(value.finalization, path), blocked = value.blocked == null ? ok(undefined) : blockedOf(value.blocked, path), claim = value.claim == null ? ok(undefined) : claimOf(value.claim, path), dedupeKey = value.dedupeKey == null ? undefined : asString(value.dedupeKey);
  return statusValue && status.has(statusValue) && round != null && startedAt != null && (value.branch == null || branch != null) && (value.stuckReason == null || stuckReason != null) && (value.completedAt == null || completedAt != null) && convergence.ok && finalization.ok && blocked.ok && claim.ok && (value.dedupeKey == null || dedupeKey != null)
    ? ok({ task: task.value, status: statusValue as TaskState['status'], branch, stuckReason, round, convergence: convergence.value, finalization: finalization.value, blocked: blocked.value, startedAt, completedAt, claim: claim.value, dedupeKey })
    : malformed(path, 'invalid task record');
};

export function parseTaskRecords(raw: string, path: string): Result<PersistedTaskRecord[]> {
  const parsed = parseJson(raw, path); if (!parsed.ok) return parsed;
  const records = asObjectArray(unwrapVersioned(parsed.value, 'tasks')); if (!records) return malformed(path, 'task queue must be an array');
  const next: PersistedTaskRecord[] = [];
  for (const [index, record] of records.entries()) { const parsedRecord = recordOf(record, `${path}[${index}]`); if (!parsedRecord.ok) return parsedRecord; next.push(parsedRecord.value); }
  return ok(next);
}
