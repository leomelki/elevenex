import { app } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
interface Palette { readonly accent: string; readonly onAccent: string; readonly ink: string; readonly surface: string }
export interface BrowserAppearance { readonly light: Palette; readonly dark: Palette; readonly duration: string; readonly baseDuration: string; readonly easeOut: string; readonly easing: string; readonly radius: string; readonly font: string }
/** Static application assets only. Native decoration uses the same authoritative tokens and local font. */
export async function browserAppearance(): Promise<BrowserAppearance> {
  const tokensPath = app.isPackaged ? join(__dirname, '../../renderer/design-system/tokens.css') : join(__dirname, '../../../../docs/design-system/project/tokens.css');
  const fontPath = app.isPackaged ? join(__dirname, '../../renderer/fonts/instrument-sans.woff2') : join(__dirname, '../../../renderer/public/fonts/instrument-sans.woff2');
  const [tokens, font] = await Promise.all([readFile(tokensPath, 'utf8'), readFile(fontPath)]);
  const property = (css: string, name: string): string => {
    const value = new RegExp('--' + name + ':\\s*([^;]+);').exec(css)?.[1]?.trim();
    if (!value) throw new Error('Missing browser design token: ' + name);
    return value;
  };
  const palette = (css: string): Palette => ({ accent: property(css, 'accent'), onAccent: property(css, 'on-accent'), ink: property(css, 'ink'), surface: property(css, 'surface-raised') });
  const dark = /\[data-theme="dark"\]\s*\{([^}]+)\}/.exec(tokens)?.[1];
  if (!dark) throw new Error('Missing dark browser tokens');
  return { light: palette(tokens), dark: palette(dark), duration: property(tokens, 'dur-slow'), baseDuration: property(tokens, 'dur-base'), easeOut: property(tokens, 'ease-out'), easing: property(tokens, 'ease-in-out'), radius: property(tokens, 'radius-md'), font: font.toString('base64') };
}
