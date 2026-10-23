import { ClickableDiv, Div, Span } from "@k8slens/element-components";
import { TextInput } from "@k8slens/input-components";
import { observer } from "mobx-react";
import { useRef, useState } from "react";
import { colourQuery, completionAt, keyText, queryKeys, quoteIfNeeded } from "../query";
import type { Session } from "../session.injectable";
import { ActionIcon } from "./action-icon";

interface Suggestion {
  readonly label: string;
  readonly hint?: string;
  readonly count?: number;
  readonly insert: string;
  /** A key goes on to its values; a value ends the clause. */
  readonly then: "values" | "space";
}

const syntaxHelp = [
  "timeout  \"exact phrase\"  -leave_out",
  "level:error  ns:argocd  pod:api-*  pod:(a OR b)",
  "@application:guestbook  @ms:>100  @trace_id:*",
  "Clauses are ANDed; the facets write here too.",
].join("\n");

const maxSuggestions = 8;

/**
 * The search box: the query language with its parts coloured, and completion of keys, fields
 * and their values from what the lines on screen hold.
 */
export const QueryInput = observer(({ session }: { readonly session: Session }) => {
  const text = session.query.get();
  const regex = session.useRegex.get();
  const input = useRef<HTMLInputElement | null>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState<number | undefined>(undefined);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const suggestions = ((): readonly Suggestion[] => {
    if (regex || caret === undefined || dismissed) {
      return [];
    }

    const completion = completionAt(text, caret);
    const sign = completion.negate ? "-" : "";

    if (completion.kind === "key") {
      const prefix = completion.prefix.toLowerCase().replace(/^@/, "");

      if (!completion.prefix) {
        return [];
      }

      const keys: Suggestion[] = queryKeys
        .filter((candidate) => !completion.prefix.startsWith("@") && candidate.key.startsWith(prefix))
        .map((candidate) => ({ label: `${candidate.key}:`, hint: candidate.hint, insert: `${sign}${candidate.key}:`, then: "values" }));
      const fields: Suggestion[] = session.fieldKeys
        .get()
        .filter((field) => field.toLowerCase().startsWith(prefix))
        .map((field) => ({ label: `@${field}:`, hint: "field", insert: `${sign}@${field}:`, then: "values" }));

      return [...keys, ...fields].slice(0, maxSuggestions);
    }

    const facet = session.facets.get().find((candidate) => candidate.key === completion.key);
    const prefix = completion.prefix.toLowerCase();

    return (facet?.values ?? [])
      .map((value) => ({ ...value, written: session.toQuery(completion.key, value.value) }))
      .filter((value) => value.written.toLowerCase().includes(prefix) && value.written.toLowerCase() !== prefix)
      .slice(0, maxSuggestions)
      .map((value) => ({
        label: value.written,
        count: value.count,
        insert: `${sign}${completion.keyWritten || keyText(completion.key)}:${quoteIfNeeded(value.written)}`,
        then: "space",
      }));
  })();

  const shown = Math.min(active, Math.max(0, suggestions.length - 1));

  const apply = (suggestion: Suggestion) => {
    if (caret === undefined) {
      return;
    }

    const completion = completionAt(text, caret);
    const before = text.slice(0, completion.start) + suggestion.insert + (suggestion.then === "space" ? " " : "");
    const next = before + text.slice(completion.end).replace(/^\s+/, suggestion.then === "space" ? "" : "");

    session.query.set(next);
    setCaret(before.length);
    setActive(0);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(before.length, before.length);
    });
  };

  const track = (element: HTMLInputElement) => {
    input.current = element;
    setCaret(element.selectionStart ?? element.value.length);

    if (overlay.current) {
      overlay.current.scrollLeft = element.scrollLeft;
    }
  };

  return (
    <Div $flex={{ gap: "xs", verticalAlign: "center" }} $className="la-search" $anchor>
      <Span $className="la-search-icon" $tooltip={syntaxHelp}>
        ⌕
      </Span>
      <Div $flexChild $className="la-query">
        {!regex && text && (
          <div ref={overlay} className="la-query-overlay" aria-hidden>
            {colourQuery(text).map((part, index) => (
              <span key={index} className={`la-q-${part.part}`}>
                {part.text}
              </span>
            ))}
          </div>
        )}
        <TextInput
          type="search"
          spellCheck={false}
          placeholder={regex ? "Filter with a regular expression   ( / )" : "Filter your logs   ( / )"}
          value={text}
          onChange={(event) => {
            session.query.set(event.target.value);
            setDismissed(false);
            setActive(0);
            track(event.target);
          }}
          onSelect={(event) => track(event.currentTarget)}
          onFocus={(event) => track(event.currentTarget)}
          onBlur={() => setTimeout(() => setCaret(undefined), 150)}
          onKeyDown={(event) => {
            if (suggestions.length === 0) {
              return;
            }

            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActive((shown + (event.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
            } else if (event.key === "Tab" || event.key === "Enter") {
              event.preventDefault();
              apply(suggestions[shown]);
            } else if (event.key === "Escape") {
              event.stopPropagation();
              setDismissed(true);
            }
          }}
          $width="full"
          $className={["la-input", "la-query-input", { "la-input--coloured": !regex && Boolean(text) }]}
        />
      </Div>
      <ActionIcon
        $onClick={() => session.caseSensitive.set(!session.caseSensitive.get())}
        $tooltip={session.caseSensitive.get() ? "Matching case. Click to match any case." : "Match case"}
        $className={["la-search-toggle", { "la-search-toggle--on": session.caseSensitive.get() }]}
      >
        Aa
      </ActionIcon>
      <ActionIcon
        $onClick={() => session.useRegex.set(!regex)}
        $tooltip={regex ? "Searching with a regular expression. Click for the query language." : "Search with a regular expression instead"}
        $className={["la-search-toggle", { "la-search-toggle--on": regex }]}
      >
        .*
      </ActionIcon>

      {suggestions.length > 0 && (
        <Div $anchoredAt="bottom span-right" $className={["la-popover", "la-suggest"]} $flex={{ direction: "vertical" }}>
          {suggestions.map((suggestion, index) => (
            <ClickableDiv
              key={suggestion.insert}
              $flex={{ gap: "s", verticalAlign: "center" }}
              $className={["la-option", { "la-option--active": index === shown }]}
              $onClick={() => apply(suggestion)}
            >
              <Span $flexChild $className="la-suggest-label">
                {suggestion.label}
              </Span>
              {suggestion.hint && <Span $className="la-option-hint">{suggestion.hint}</Span>}
              {suggestion.count !== undefined && <Span $className="la-facet-count">{suggestion.count.toLocaleString()}</Span>}
            </ClickableDiv>
          ))}
        </Div>
      )}
    </Div>
  );
});
