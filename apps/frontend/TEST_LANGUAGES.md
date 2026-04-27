# VS Code Web Language Support

This phase replaces Monaco with VS Code Web inside the session workspace.

## Verified Support Matrix

| Language | Syntax highlighting | Browser IntelliSense | Notes |
|----------|---------------------|----------------------|-------|
| TypeScript | Yes | Yes | Supports completions and navigation through built-in web language services. |
| JavaScript | Yes | Yes | Uses the same browser-hosted language service pipeline as TypeScript. |
| HTML | Yes | Yes | Tag and attribute completion available in VS Code Web. |
| CSS | Yes | Yes | Property and value suggestions available in VS Code Web. |
| JSON | Yes | Yes | Schema-aware completions available when the file provides them. |
| Go | Yes | No | `gopls` is a native binary and is not available inside the browser-hosted iframe. |
| Python | Yes | No | Syntax highlighting works, but no bundled browser IntelliSense is expected. |

## Manual Verification Steps

1. Start the backend and frontend.
2. Open a session with the VS Code Web panel enabled.
3. Open representative `.ts`, `.html`, `.css`, `.json`, `.go`, and `.py` files in the iframe.
4. Confirm syntax highlighting is present for all file types.
5. Confirm completions/navigation work for TypeScript, JavaScript, HTML, CSS, and JSON.
6. Confirm Go and Python remain readable, but do not expose native-server IntelliSense.
