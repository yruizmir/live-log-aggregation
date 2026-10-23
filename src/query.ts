import type { FacetFilter, FacetKey } from "./model";

/**
 * The search language of the tab, a subset of Datadog's:
 *
 *   timeout "connection refused"   free text and exact phrases, in the message or pod/container
 *   -timeout  -pod:api-*           leaving out
 *   level:error  ns:argocd         the facets; status: is level:, ns: is namespace:
 *   pod:api-*  pod:(a OR b)        wildcards and alternatives
 *   @application:guestbook         fields of JSON and logfmt lines (the @ may be left out)
 *   @ms:>100  @code:>=500          numeric comparisons
 *   @trace_id:*                    the field is there
 *
 * Clauses are ANDed. The text is the one source of truth: the facet panel reads its selection
 * from the exact `key:value` clauses and writes them back here.
 */

export type Comparison = ">" | ">=" | "<" | "<=";

export type Clause =
  | { readonly kind: "text"; readonly value: string; readonly negate: boolean }
  | {
      readonly kind: "field";
      readonly key: FacetKey;
      readonly negate: boolean;
      /** Alternatives; a value with `*` is a wildcard. */
      readonly values: readonly string[];
    }
  | { readonly kind: "exists"; readonly key: FacetKey; readonly negate: boolean }
  | { readonly kind: "compare"; readonly key: FacetKey; readonly negate: boolean; readonly op: Comparison; readonly number: number };

interface Token {
  readonly raw: string;
  readonly start: number;
  readonly end: number;
  readonly clause?: Clause;
}

export interface ParsedQuery {
  readonly clauses: readonly Clause[];
  readonly problems: readonly string[];
}

const reservedKeys: Record<string, FacetKey> = {
  level: "level",
  status: "level",
  cluster: "cluster",
  namespace: "namespace",
  ns: "namespace",
  workload: "workload",
  pod: "pod",
  container: "container",
  run: "run",
};

export const queryKeys: readonly { readonly key: string; readonly facet: FacetKey; readonly hint: string }[] = [
  { key: "level", facet: "level", hint: "error, warn, info, debug" },
  { key: "cluster", facet: "cluster", hint: "cluster name" },
  { key: "namespace", facet: "namespace", hint: "namespace" },
  { key: "workload", facet: "workload", hint: "Deployment name, StatefulSet name…" },
  { key: "pod", facet: "pod", hint: "pod name, * for any part" },
  { key: "container", facet: "container", hint: "container name" },
  { key: "run", facet: "run", hint: "current or previous (before the last restart)" },
];

const keyPattern = /^(@?)([A-Za-z_][\w.\-/]*):(.*)$/s;

const unquote = (value: string) =>
  value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1).replace(/\\"/g, '"') : value;

export const quoteIfNeeded = (value: string) => (/[\s"():]/.test(value) || value === "" ? `"${value.replace(/"/g, '\\"')}"` : value);

/** Splits on blanks outside quotes and parentheses, keeping where each token sits in the text. */
const tokenize = (text: string): { raw: string; start: number; end: number }[] => {
  const tokens: { raw: string; start: number; end: number }[] = [];
  let start = -1;
  let quoted = false;
  let depth = 0;

  for (let index = 0; index <= text.length; index++) {
    const character = text[index];
    const atEnd = index === text.length;

    if (!atEnd && start === -1 && /\s/.test(character)) {
      continue;
    }

    if (!atEnd && start === -1) {
      start = index;
    }

    if (atEnd || (!quoted && depth === 0 && /\s/.test(character))) {
      if (start !== -1) {
        tokens.push({ raw: text.slice(start, index), start, end: index });
        start = -1;
      }

      continue;
    }

    if (character === '"' && text[index - 1] !== "\\") {
      quoted = !quoted;
    } else if (!quoted && character === "(") {
      depth++;
    } else if (!quoted && character === ")") {
      depth = Math.max(0, depth - 1);
    }
  }

  return tokens;
};

const keyOf = (at: string, name: string): FacetKey | undefined => {
  if (at) {
    return `field:${name}`;
  }

  return reservedKeys[name.toLowerCase()] ?? `field:${name}`;
};

const parseToken = (raw: string, problems: string[]): Clause | undefined => {
  const negate = raw.startsWith("-") && raw.length > 1;
  const body = negate ? raw.slice(1) : raw;

  if (body === "OR" || body === "AND") {
    problems.push(`${body} only works inside key:(a OR b); clauses are always ANDed.`);

    return undefined;
  }

  const match = keyPattern.exec(body);

  // "http://…" and "12:30" are text, not keys.
  if (!match || match[3].startsWith("/") || /^\d+$/.test(match[2])) {
    const value = unquote(body);

    return value ? { kind: "text", value: value.toLowerCase(), negate } : undefined;
  }

  const [, at, name, rest] = match;
  const key = keyOf(at, name)!;

  if (rest === "") {
    return undefined;
  }

  if (rest === "*") {
    return { kind: "exists", key, negate };
  }

  const comparison = /^(>=|<=|>|<)(-?\d+(?:\.\d+)?)$/.exec(rest);

  if (comparison) {
    return { kind: "compare", key, negate, op: comparison[1] as Comparison, number: Number(comparison[2]) };
  }

  if (/^[<>]/.test(rest)) {
    problems.push(`${raw}: compare with a number, like ${at}${name}:>100`);

    return undefined;
  }

  if (rest.startsWith("(")) {
    if (!rest.endsWith(")")) {
      problems.push(`${raw}: missing ")"`);

      return undefined;
    }

    const values = rest
      .slice(1, -1)
      .split(/\s+OR\s+/i)
      .map((value) => unquote(value.trim()))
      .filter(Boolean);

    return values.length > 0 ? { kind: "field", key, negate, values } : undefined;
  }

  return { kind: "field", key, negate, values: [unquote(rest)] };
};

const parseTokens = (text: string) => {
  const problems: string[] = [];
  const tokens: Token[] = tokenize(text).map((token) => ({ ...token, clause: parseToken(token.raw, problems) }));

  if ((text.match(/(?<!\\)"/g)?.length ?? 0) % 2 === 1) {
    problems.push('A quote is not closed.');
  }

  return { tokens, problems };
};

export const parseQuery = (text: string): ParsedQuery => {
  const { tokens, problems } = parseTokens(text);

  return { clauses: tokens.flatMap((token) => (token.clause ? [token.clause] : [])), problems };
};

const wildcards = new Map<string, RegExp>();

const wildcardOf = (value: string) => {
  let pattern = wildcards.get(value);

  if (!pattern) {
    pattern = new RegExp(`^${value.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
    wildcards.set(value, pattern);
  }

  return pattern;
};

/** An exact `key:value` clause without wildcards: the kind the facet panel shows as ticked. */
export const isFacetClause = (clause: Clause): clause is Extract<Clause, { kind: "field" }> =>
  clause.kind === "field" && clause.values.every((value) => !value.includes("*"));

export interface Resolver<Line> {
  /** The value a line has for a key, as the facets know it. */
  readonly valueOf: (key: FacetKey, line: Line) => string | undefined;
  /** How a facet value is written in the query (a cluster id becomes its name). */
  readonly toQuery?: (key: FacetKey, value: string) => string;
}

const valueMatches = (wanted: string, written: readonly string[]) =>
  wanted.includes("*")
    ? written.some((candidate) => wildcardOf(wanted).test(candidate))
    : written.some((candidate) => candidate.toLowerCase() === wanted.toLowerCase());

/** Whether a line passes one clause; `searchable` is the lower-cased text free terms are looked for in. */
export const clauseMatches = <Line>(clause: Clause, line: Line, searchable: (line: Line) => string, resolver: Resolver<Line>) => {
  let passes: boolean;

  if (clause.kind === "text") {
    passes = searchable(line).includes(clause.value);
  } else {
    const value = resolver.valueOf(clause.key, line);

    if (clause.kind === "exists") {
      passes = value !== undefined && value !== "";
    } else if (clause.kind === "compare") {
      const number = value === undefined ? Number.NaN : Number.parseFloat(value);

      passes =
        !Number.isNaN(number) &&
        (clause.op === ">" ? number > clause.number : clause.op === ">=" ? number >= clause.number : clause.op === "<" ? number < clause.number : number <= clause.number);
    } else {
      const written = value === undefined ? [] : [value, resolver.toQuery?.(clause.key, value) ?? value];

      passes = clause.values.some((wanted) => valueMatches(wanted, written));
    }
  }

  return clause.negate ? !passes : passes;
};

/** What the facet panel shows ticked and crossed out, read from the exact clauses. */
export const facetSelections = (clauses: readonly Clause[], fromQuery?: (key: FacetKey, value: string) => string) => {
  const selections = new Map<FacetKey, { include: string[]; exclude: string[] }>();

  for (const clause of clauses) {
    if (!isFacetClause(clause)) {
      continue;
    }

    const selection = selections.get(clause.key) ?? { include: [], exclude: [] };

    for (const value of clause.values) {
      const canonical = fromQuery?.(clause.key, value) ?? value;

      (clause.negate ? selection.exclude : selection.include).push(canonical);
    }

    selections.set(clause.key, selection);
  }

  return selections as Map<FacetKey, FacetFilter>;
};

export const keyText = (key: FacetKey) => (key.startsWith("field:") ? `@${key.slice("field:".length)}` : key);

const serialize = (key: FacetKey, values: readonly string[], negate: boolean) => {
  const written = values.map(quoteIfNeeded);

  return `${negate ? "-" : ""}${keyText(key)}:${written.length === 1 ? written[0] : `(${written.join(" OR ")})`}`;
};

/**
 * The query with one facet's exact clauses replaced by `include` and `exclude`, every other
 * clause left as the user wrote it.
 */
export const setFacetInQuery = (
  text: string,
  key: FacetKey,
  filter: FacetFilter,
  toQuery: (key: FacetKey, value: string) => string = (_, value) => value,
) => {
  const { tokens } = parseTokens(text);
  const kept = tokens.filter((token) => !(token.clause && isFacetClause(token.clause) && token.clause.key === key)).map((token) => token.raw);
  const added = [
    ...(filter.include.length > 0 ? [serialize(key, filter.include.map((value) => toQuery(key, value)), false)] : []),
    ...filter.exclude.map((value) => serialize(key, [toQuery(key, value)], true)),
  ];

  return [...kept, ...added].join(" ");
};

/** The positive free text, for marking it in the list. */
export const highlightTerms = (clauses: readonly Clause[]) =>
  clauses.flatMap((clause) => (clause.kind === "text" && !clause.negate ? [clause.value] : []));

export type QueryPart = "text" | "negate" | "key" | "field" | "value" | "operator" | "space";

/** The query cut into coloured parts, for the overlay behind the search box. */
export const colourQuery = (text: string): { readonly text: string; readonly part: QueryPart }[] => {
  const parts: { text: string; part: QueryPart }[] = [];
  let last = 0;

  for (const token of tokenize(text)) {
    if (token.start > last) {
      parts.push({ text: text.slice(last, token.start), part: "space" });
    }

    const negate = token.raw.startsWith("-") && token.raw.length > 1;
    const body = negate ? token.raw.slice(1) : token.raw;
    const match = keyPattern.exec(body);

    if (negate) {
      parts.push({ text: "-", part: "negate" });
    }

    if (match && !match[3].startsWith("/") && !/^\d+$/.test(match[2])) {
      const [, at, name, rest] = match;

      parts.push({ text: `${at}${name}:`, part: at || !reservedKeys[name.toLowerCase()] ? "field" : "key" });

      const operator = /^(>=|<=|>|<)/.exec(rest)?.[0] ?? "";

      if (operator) {
        parts.push({ text: operator, part: "operator" });
      }

      parts.push({ text: rest.slice(operator.length), part: negate ? "negate" : "value" });
    } else if (body === "OR" || body === "AND") {
      parts.push({ text: body, part: "operator" });
    } else {
      parts.push({ text: body, part: negate ? "negate" : "text" });
    }

    last = token.end;
  }

  if (last < text.length) {
    parts.push({ text: text.slice(last), part: "space" });
  }

  return parts;
};

/** The token the caret is in, and what it asks to be completed with. */
export const completionAt = (text: string, caret: number) => {
  let start = caret;

  while (start > 0 && !/\s/.test(text[start - 1])) {
    start--;
  }

  let end = caret;

  while (end < text.length && !/\s/.test(text[end])) {
    end++;
  }

  const token = text.slice(start, caret);
  const negate = token.startsWith("-");
  const body = negate ? token.slice(1) : token;
  const colon = body.indexOf(":");

  if (colon === -1) {
    return { start, end, negate, kind: "key" as const, prefix: body };
  }

  const name = body.slice(0, colon);
  const at = name.startsWith("@");
  const key = keyOf(at ? "@" : "", at ? name.slice(1) : name)!;

  return { start, end, negate, kind: "value" as const, key, keyWritten: name, prefix: unquote(body.slice(colon + 1)).replace(/^\(/, "") };
};
