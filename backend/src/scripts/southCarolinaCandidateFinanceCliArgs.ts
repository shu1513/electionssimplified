const SOUTH_CAROLINA_FINANCE_BOOLEAN_FLAGS = new Set(["--dry-run", "--force", "--no-auto-link", "--refresh"]);
const SOUTH_CAROLINA_FINANCE_VALUE_FLAGS = new Set([
  "--max-candidates",
  "--stale-after-days",
  "--lookback-days",
  "--lookahead-days",
  "--candidate-name",
  "--election-date",
  "--filer-id",
  "--candidate-id",
  "--election-year",
  "--source-cache-dir",
]);

export function assertNoUnknownSouthCarolinaFinanceFlags(args: readonly string[]): void {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const flag = arg.split("=", 1)[0] ?? arg;
    if (SOUTH_CAROLINA_FINANCE_BOOLEAN_FLAGS.has(flag)) {
      continue;
    }
    if (SOUTH_CAROLINA_FINANCE_VALUE_FLAGS.has(flag)) {
      if (!arg.includes("=")) {
        index += 1;
      }
      continue;
    }
    throw new Error(`Unknown option: ${flag}`);
  }
}

export function parseSouthCarolinaFinanceFlagValue(args: readonly string[], name: string): string | null {
  const inlinePrefix = `${name}=`;
  const values: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith(inlinePrefix)) {
      const value = arg.slice(inlinePrefix.length).trim();
      if (value.length === 0) {
        throw new Error(`Missing ${name} value`);
      }
      values.push(value);
      continue;
    }
    if (arg === name) {
      const next = args[index + 1];
      if (!next || next.startsWith("--") || next.trim().length === 0) {
        throw new Error(`Missing ${name} value`);
      }
      values.push(next.trim());
      index += 1;
    }
  }

  if (values.length > 1) {
    throw new Error(`Provide ${name} at most once`);
  }
  return values[0] ?? null;
}

export function parseSouthCarolinaFinancePositiveIntegerFlag(
  args: readonly string[],
  name: string
): number | undefined {
  const raw = parseSouthCarolinaFinanceFlagValue(args, name);
  if (raw === null) {
    return undefined;
  }
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`Invalid ${name} value: ${raw}`);
  }
  // Digit-only values above 2^53 - 1 would be silently rounded by Number().
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid ${name} value: ${raw}`);
  }
  return parsed;
}
