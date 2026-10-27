import { Kind, parse, type FieldNode, type SelectionSetNode } from 'graphql';

// Linear rejects any query above 10,000 complexity points, scored from the requested
// page sizes: 0.1 per field, 1 per object, and each connection multiplies its children
// by `first` (default 50). https://linear.app/developers/rate-limiting#complexity-limits
// This estimator follows those rules without the schema: a field with a selection set is
// an object, and a field with a `first` argument is a connection.

export const LIMIT = 10_000;
export const BUDGET = 5_000;

function firstArg(field: FieldNode): number | null {
  const arg = field.arguments?.find((a) => a.name.value === 'first');
  if (!arg) return null;
  if (arg.value.kind !== Kind.INT) throw new Error(`${field.name.value}: use a literal page size so complexity is predictable`);
  return Number(arg.value.value);
}

function cost(set: SelectionSetNode): number {
  let total = 0;
  for (const sel of set.selections) {
    if (sel.kind !== Kind.FIELD) continue;
    if (!sel.selectionSet) {
      total += 0.1;
      continue;
    }
    const children = cost(sel.selectionSet);
    const hasNodes = sel.selectionSet.selections.some((s) => s.kind === Kind.FIELD && s.name.value === 'nodes');
    const first = firstArg(sel);
    if (hasNodes && first == null) throw new Error(`${sel.name.value}: connection without an explicit first (Linear defaults to 50)`);
    total += 1 + (first ?? 1) * children;
  }
  return total;
}

export function estimateComplexity(query: string): number {
  const op = parse(query).definitions[0];
  if (op.kind !== Kind.OPERATION_DEFINITION) throw new Error('expected an operation');
  return Math.ceil(cost(op.selectionSet));
}

