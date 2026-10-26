export interface CodeToken {
  readonly kind:
    | "plain"
    | "keyword"
    | "string"
    | "number"
    | "function"
    | "comment";
  readonly text: string;
}
/** A display lexer only: never executes source, never creates HTML. */
export function codeTokens(
  source: string,
  language: string,
): readonly CodeToken[] {
  if (!/^(?:[cm]?[jt]sx?|javascript|typescript)$/i.test(language))
    return [{ kind: "plain", text: source }];
  const pattern =
    /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:async|await|break|case|catch|class|const|continue|default|delete|do|else|export|extends|false|finally|for|from|function|if|implements|import|in|interface|let|new|null|of|private|protected|public|readonly|return|static|super|switch|this|throw|true|try|type|typeof|undefined|var|void|while|yield)\b|\b(?:0x[\da-f]+|\d+(?:\.\d+)?)\b|\b[A-Za-z_$][\w$]*(?=\s*\()/gi;
  const tokens: CodeToken[] = [];
  let offset = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > offset)
      tokens.push({ kind: "plain", text: source.slice(offset, match.index) });
    const text = match[0];
    const kind: CodeToken["kind"] =
      text.startsWith("//") || text.startsWith("/*")
        ? "comment"
        : /^["'`]/.test(text)
          ? "string"
          : /^\d/.test(text)
            ? "number"
            : /^[A-Za-z_$][\w$]*$/.test(text) &&
                source
                  .slice(match.index + text.length)
                  .trimStart()
                  .startsWith("(")
              ? "function"
              : "keyword";
    tokens.push({ kind, text });
    offset = match.index + text.length;
  }
  if (offset < source.length)
    tokens.push({ kind: "plain", text: source.slice(offset) });
  return tokens;
}
