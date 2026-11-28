import { describe, expect, it } from "vitest";
import { codeTokens } from "./code-tokens";
describe("code display lexer", () => {
  it("preserves exact source while assigning semantic palette categories", () => {
    const source =
      '// Keep abort\nconst delay = clamp(42, "safe");\n<img onerror=run()>';
    const tokens = codeTokens(source, "ts");
    expect(tokens.map((token) => token.text).join("")).toBe(source);
    expect(tokens.some((token) => token.kind === "comment")).toBe(true);
    expect(
      tokens.some(
        (token) => token.kind === "keyword" && token.text === "const",
      ),
    ).toBe(true);
    expect(
      tokens.some((token) => token.kind === "number" && token.text === "42"),
    ).toBe(true);
    expect(tokens.some((token) => token.kind === "string")).toBe(true);
    expect(codeTokens(source, "shell")).toEqual([
      { kind: "plain", text: source },
    ]);
  });
});
