const TENNESSEE_FINANCE_BOOLEAN_FLAGS = new Set(["--dry-run", "--force", "--no-ai-classify-industries", "--no-auto-link"]);
const TENNESSEE_FINANCE_VALUE_FLAGS = new Set([
  "--max-candidates",
  "--stale-after-days",
  "--lookback-days",
  "--lookahead-days",
  "--ai-min-amount",
  "--candidate-id",
  "--election-year",
  "--raw-cache-dir",
]);

export function assertNoUnknownTennesseeFinanceFlags(args: readonly string[]): void {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const flag = arg.split("=", 1)[0] ?? arg;
    if (TENNESSEE_FINANCE_BOOLEAN_FLAGS.has(flag)) {
      continue;
    }
    if (TENNESSEE_FINANCE_VALUE_FLAGS.has(flag)) {
      if (!arg.includes("=")) {
        index += 1;
      }
      continue;
    }
    throw new Error(`Unknown option: ${flag}`);
  }
}

export function parseTennesseeFinanceFlagValue(args: readonly string[], name: string): string | null {
  const inlinePrefix = `${name}=`;
  const values: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
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

export function parseTennesseeFinancePositiveIntegerFlag(args: readonly string[], name: string): number | undefined {
  const raw = parseTennesseeFinanceFlagValue(args, name);
  if (raw === null) {
    return undefined;
  }
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`Invalid ${name} value: ${raw}`);
  }
  return Number(raw);
}
