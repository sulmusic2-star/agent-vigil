const encoder = new TextEncoder();

export interface DutySecret {
  name: string;
  value: string;
}

export function dutySecretsAreSeparated(secrets: readonly DutySecret[]): boolean {
  return (
    secrets.every(({ value }) => typeof value === "string" && encoder.encode(value).byteLength >= 32) &&
    new Set(secrets.map(({ value }) => value)).size === secrets.length
  );
}
