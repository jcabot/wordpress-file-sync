const TOLERANCE_MS = 2000;

function appendZ(s: string): string {
  return /[Zz]|[+-]\d{2}:\d{2}$/.test(s) ? s : `${s}Z`;
}

export interface ConflictInput {
  serverModifiedGmt: string;
  localModifiedGmt: string;
  fileMtimeMs: number;
}

export function isConflicted(input: ConflictInput): boolean {
  const ref = Date.parse(appendZ(input.localModifiedGmt));
  const serverChanged = Date.parse(appendZ(input.serverModifiedGmt)) > ref;
  const localChanged = input.fileMtimeMs > ref + TOLERANCE_MS;
  return serverChanged && localChanged;
}

export function serverChanged(serverModifiedGmt: string, localModifiedGmt: string): boolean {
  return Date.parse(appendZ(serverModifiedGmt)) > Date.parse(appendZ(localModifiedGmt));
}

export function localChanged(fileMtimeMs: number, localModifiedGmt: string): boolean {
  return fileMtimeMs > Date.parse(appendZ(localModifiedGmt)) + TOLERANCE_MS;
}
