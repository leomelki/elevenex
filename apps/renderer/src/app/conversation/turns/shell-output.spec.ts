import { describe, expect, it } from "vitest";
import {
  parseTerminalOutput,
  shellOutputWindow,
  terminalPlainText,
} from "./shell-output";
const plain = (value: string) => terminalPlainText(parseTerminalOutput(value));

describe("captured shell output", () => {
  it("preserves whitespace, blank lines, CRLF, and carriage-return overwrites", () => {
    expect(plain("  build\r\n\r\n  done  \n")).toBe("  build\n\n  done  ");
    expect(plain("12345\rhi")).toBe("hi345");
    expect(plain("progress 10%\rprogress 90%\nfinished")).toBe(
      "progress 90%\nfinished",
    );
    expect(plain("keep\r")).toBe("keep");
    expect(plain("\u001b[31mABCDE\r\u001b[32mhi\u001b[0m!")).toBe("hi!DE");
  });
  it("maps ANSI colors to theme tokens and emits bounded style data, never HTML", () => {
    const lines = parseTerminalOutput(
      "\u001b[1;31mfail\u001b[0m <script>alert(1)</script>\n\u001b[38;2;1;2;3mRGB\u001b[0m",
    );
    expect(lines[0]?.[0]).toMatchObject({
      text: "fail",
      fg: "var(--danger)",
      decoration: "term--bold",
    });
    expect(lines[1]?.[0]?.fg).toBe("rgb(1, 2, 3)");
    expect(terminalPlainText(lines)).toContain("<script>alert(1)</script>");
    expect(
      plain(
        "\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007\u0007\u001b[2J",
      ),
    ).toBe("link");
    expect(plain("\u001b]52;c;clipboard-payload\u001b\\safe")).toBe("safe");
  });
  it("bounds pathological source text and both DOM windows without losing the final result", () => {
    const lines = parseTerminalOutput("x".repeat(200_000) + "\nlast result");
    expect(terminalPlainText(lines).length).toBeLessThanOrEqual(100_000);
    const many = parseTerminalOutput(
      Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n"),
    );
    expect(shellOutputWindow(many, false)).toMatchObject({ hidden: 4920 });
    expect(shellOutputWindow(many, false).lines).toHaveLength(80);
    expect(shellOutputWindow(many, true).lines).toHaveLength(1000);
    expect(terminalPlainText(shellOutputWindow(many, true).lines)).toContain(
      "line 4999",
    );
  });
});
