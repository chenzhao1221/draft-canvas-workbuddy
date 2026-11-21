/**
 * Text size and font of the draft editors (editor, compare and review). The panel sets them as the CSS
 * custom properties `--dc-editor-font-size` and `--dc-editor-font` on its root; the editor themes read them.
 */

export type EditorFont = 'mono' | 'song' | 'hei' | 'kai';

export interface TextStyle {
  /** Pixels, between `MIN_FONT_SIZE` and `MAX_FONT_SIZE`. */
  size: number;
  font: EditorFont;
}

export const MIN_FONT_SIZE = 12;
export const MAX_FONT_SIZE = 24;

/** The default look from 0.1.12: 16 px Hei (sans-serif CJK), as in the panel design. */
export const DEFAULT_TEXT_STYLE: TextStyle = { size: 16, font: 'hei' };

/** Font stacks per choice, Windows and macOS names first, then common Linux CJK fonts, then the generic family. */
export const FONT_STACKS: Record<EditorFont, string> = {
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  song: '"Songti SC", SimSun, "Noto Serif CJK SC", "Source Han Serif SC", serif',
  hei: '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif',
  kai: '"Kaiti SC", KaiTi, STKaiti, serif',
};

export const EDITOR_FONTS: readonly EditorFont[] = ['mono', 'song', 'hei', 'kai'];

export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_TEXT_STYLE.size;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size)));
}

function isEditorFont(value: unknown): value is EditorFont {
  return typeof value === 'string' && (EDITOR_FONTS as readonly string[]).includes(value);
}

/** Reads a stored text style (JSON). Unknown or broken values give the default; a bad field keeps its default. */
export function parseTextStyle(value: unknown): TextStyle {
  let data: unknown = value;
  if (typeof value === 'string') {
    try {
      data = JSON.parse(value);
    } catch {
      return { ...DEFAULT_TEXT_STYLE };
    }
  }
  if (typeof data !== 'object' || data === null) return { ...DEFAULT_TEXT_STYLE };
  const record = data as { size?: unknown; font?: unknown };
  return {
    size: typeof record.size === 'number' ? clampFontSize(record.size) : DEFAULT_TEXT_STYLE.size,
    font: isEditorFont(record.font) ? record.font : DEFAULT_TEXT_STYLE.font,
  };
}

export function serializeTextStyle(style: TextStyle): string {
  return JSON.stringify({ size: style.size, font: style.font });
}

/** The CSS custom properties the editor themes read. */
export function textStyleVariables(style: TextStyle): Record<string, string> {
  return {
    '--dc-editor-font-size': `${style.size}px`,
    '--dc-editor-font': FONT_STACKS[style.font],
  };
}
