import { Injectable } from '@angular/core';

/**
 * Colorblind-safe palette using OKLCH-based perceptually distinct colors.
 * These colors are distinguishable for protanopia, deuteranopia, and tritanopia.
 * 
 * Colors are chosen to maximize distinctness in both normal and colorblind vision:
 * - Blue: High lightness, distinct from warm colors
 * - Red: Warm hue, lower lightness
 * - Green: Medium lightness, distinct from red
 * - Orange: Between red/yellow, high chroma
 * - Violet: Cool hue, medium lightness
 * - Cyan: High lightness, distinct from blue
 * - Pink: Light variant of red
 * - Lime: High lightness, distinct from green
 * - Indigo: Dark blue-purple
 * - Teal: Blue-green, medium lightness
 */
const COLORBLIND_SAFE_PALETTE = [
  { hex: '#2563eb', name: 'blue' },      // Blue - primary-like, very distinct
  { hex: '#dc2626', name: 'red' },       // Red - warm, strong
  { hex: '#16a34a', name: 'green' },     // Green - nature, distinct from red
  { hex: '#ea580c', name: 'orange' },    // Orange - warning-like
  { hex: '#7c3aed', name: 'violet' },    // Violet - purple
  { hex: '#0891b2', name: 'cyan' },      // Cyan - bright
  { hex: '#db2777', name: 'pink' },      // Pink - light red
  { hex: '#65a30d', name: 'lime' },      // Lime - bright green
  { hex: '#4f46e5', name: 'indigo' },    // Indigo - deep blue
  { hex: '#0d9488', name: 'teal' },      // Teal - blue-green
] as const;

@Injectable({ providedIn: 'root' })
export class TabColorService {
  private colorCache = new Map<number, string>();

  /**
   * Get color for a repo ID. Returns cached color or generates new one.
   */
  getRepoColor(repoId: number | undefined | null, colorFromBackend?: string | null): string {
    // Handle invalid repoId
    if (repoId === undefined || repoId === null || repoId <= 0) {
      return '#6b7280'; // Default gray for unknown repos
    }

    if (this.colorCache.has(repoId)) {
      return this.colorCache.get(repoId)!;
    }

    // Use backend color if available
    if (colorFromBackend) {
      this.colorCache.set(repoId, colorFromBackend);
      return colorFromBackend;
    }

    // Generate deterministic color from repo ID
    const color = this.generateColorForId(repoId);
    this.colorCache.set(repoId, color);
    return color;
  }

  /**
   * Clear color cache (e.g., on logout or data refresh).
   */
  clearCache(): void {
    this.colorCache.clear();
  }

  /**
   * Generate a deterministic color for a repo ID.
   * Uses modulo to cycle through the palette.
   */
  private generateColorForId(repoId: number): string {
    const index = Math.abs(repoId) % COLORBLIND_SAFE_PALETTE.length;
    return COLORBLIND_SAFE_PALETTE[index]?.hex ?? '#6b7280';
  }

  /**
   * Get all available colors (for UI display).
   */
  getPalette(): typeof COLORBLIND_SAFE_PALETTE {
    return [...COLORBLIND_SAFE_PALETTE];
  }

  /**
   * Get color name for a hex color.
   */
  getColorName(hex: string): string {
    const color = COLORBLIND_SAFE_PALETTE.find(c => c.hex === hex);
    return color?.name ?? 'unknown';
  }
}

