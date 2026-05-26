export type ConflictResolutionStrategy = 'current' | 'incoming' | 'both';

export interface ConflictSection {
  startLine: number;
  endLine: number;
  content: string[];
}

export interface ConflictBlock {
  id: string;
  startLine: number;
  endLine: number;
  oursLabel: string;
  theirsLabel: string;
  baseLabel: string | null;
  ours: ConflictSection;
  theirs: ConflictSection;
  base: ConflictSection | null;
}

interface SplitContent {
  lines: string[];
  newline: string;
  trailingNewline: boolean;
}

export function parseConflictBlocks(content: string): ConflictBlock[] {
  const { lines } = splitContent(content);
  const blocks: ConflictBlock[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith('<<<<<<<')) continue;

    const oursMarker = index;
    const oursLabel = line.slice('<<<<<<<'.length).trim() || 'current';
    let baseMarker: number | null = null;
    let separator: number | null = null;
    let endMarker: number | null = null;

    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor];
      if (separator === null && baseMarker === null && candidate.startsWith('|||||||')) {
        baseMarker = cursor;
        continue;
      }
      if (separator === null && candidate.startsWith('=======')) {
        separator = cursor;
        continue;
      }
      if (separator !== null && candidate.startsWith('>>>>>>>')) {
        endMarker = cursor;
        break;
      }
    }

    if (separator === null || endMarker === null) {
      continue;
    }

    const oursStart = oursMarker + 1;
    const oursEnd = baseMarker ?? separator;
    const baseStart = baseMarker === null ? null : baseMarker + 1;
    const baseEnd = baseMarker === null ? null : separator;
    const theirsStart = separator + 1;
    const theirsEnd = endMarker;
    const theirsLabel = lines[endMarker].slice('>>>>>>>'.length).trim() || 'incoming';
    const baseLabel = baseMarker === null ? null : lines[baseMarker].slice('|||||||'.length).trim() || 'base';

    blocks.push({
      id: `conflict-${oursMarker + 1}-${endMarker + 1}`,
      startLine: oursMarker + 1,
      endLine: endMarker + 1,
      oursLabel,
      theirsLabel,
      baseLabel,
      ours: buildSection(lines, oursStart, oursEnd),
      base: baseStart === null || baseEnd === null ? null : buildSection(lines, baseStart, baseEnd),
      theirs: buildSection(lines, theirsStart, theirsEnd),
    });
    index = endMarker;
  }

  return blocks;
}

export function applyConflictResolution(
  content: string,
  block: ConflictBlock,
  strategy: ConflictResolutionStrategy,
): string {
  const split = splitContent(content);
  const replacement = replacementLines(block, strategy);
  const startIndex = Math.max(0, block.startLine - 1);
  const endIndex = Math.min(split.lines.length, block.endLine);
  const nextLines = [
    ...split.lines.slice(0, startIndex),
    ...replacement,
    ...split.lines.slice(endIndex),
  ];

  const joined = nextLines.join(split.newline);
  return split.trailingNewline ? `${joined}${split.newline}` : joined;
}

function buildSection(lines: string[], startIndex: number, endIndex: number): ConflictSection {
  return {
    startLine: startIndex + 1,
    endLine: endIndex,
    content: lines.slice(startIndex, endIndex),
  };
}

function replacementLines(block: ConflictBlock, strategy: ConflictResolutionStrategy): string[] {
  switch (strategy) {
    case 'current':
      return block.ours.content;
    case 'incoming':
      return block.theirs.content;
    case 'both':
      return [...block.ours.content, ...block.theirs.content];
  }
}

function splitContent(content: string): SplitContent {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = content.endsWith('\n');
  const lines = content.split(/\r?\n/);
  if (trailingNewline) {
    lines.pop();
  }
  return { lines, newline, trailingNewline };
}
