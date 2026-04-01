import { err, ok, type Result } from '../shared/result.js';

export type JsonMap = Record<string, unknown>;
export const asObject = (value: unknown): JsonMap | undefined => value != null && typeof value === 'object' && !Array.isArray(value) ? value as JsonMap : undefined;
export const asString = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
export const asNumber = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
export const asBoolean = (value: unknown): boolean | undefined => typeof value === 'boolean' ? value : undefined;
export const asStringArray = (value: unknown): string[] | undefined => Array.isArray(value) && value.every(item => typeof item === 'string') ? value : undefined;
export const asObjectArray = (value: unknown): JsonMap[] | undefined => Array.isArray(value) && value.every(item => asObject(item)) ? value as JsonMap[] : undefined;
export const malformed = <T>(path: string, detail?: string): Result<T> => err('TRANSPORT_ERROR', detail ? `Malformed ${path}: ${detail}` : `Malformed ${path}`);
export const parseJson = (raw: string, path: string): Result<unknown> => {
  try { return ok(JSON.parse(raw)); }
  catch { return malformed(path); }
};
export const unwrapVersioned = (value: unknown, key: string): unknown => {
  const object = asObject(value);
  return object && typeof object.version === 'number' && Object.hasOwn(object, key) ? object[key] : value;
};
