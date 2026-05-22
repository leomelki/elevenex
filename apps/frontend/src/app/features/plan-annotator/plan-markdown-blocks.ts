export type PlanMarkdownBlockType =
  | 'heading'
  | 'paragraph'
  | 'list-item'
  | 'blockquote'
  | 'code'
  | 'table'
  | 'hr';

export interface PlanMarkdownBlock {
  id: string;
  type: PlanMarkdownBlockType;
  content: string;
  raw: string;
  level: number;
  order: number;
  startLine: number;
  language?: string;
  checked?: boolean;
  ordered?: boolean;
}

export function parsePlanMarkdownBlocks(markdown: string): PlanMarkdownBlock[] {
  const lines = stripFrontmatter(markdown).split('\n');
  const blocks: PlanMarkdownBlock[] = [];
  let index = 0;
  let buffer: string[] = [];
  let bufferStartLine = 1;

  const flushParagraph = () => {
    if (!buffer.length) return;
    blocks.push(
      createBlock(index++, 'paragraph', buffer.join('\n'), {
        raw: buffer.join('\n'),
        startLine: bufferStartLine,
      }),
    );
    buffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const lineNumber = i + 1;

    if (!trimmed) {
      flushParagraph();
      continue;
    }

    const codeFence = /^(`{3,}|~{3,})(.*)$/.exec(trimmed);
    if (codeFence) {
      flushParagraph();
      const fence = codeFence[1][0];
      const fenceLength = codeFence[1].length;
      const closingFence = new RegExp(`^${escapeRegExp(fence)}{${fenceLength},}\\s*$`);
      const language = codeFence[2]?.trim() || undefined;
      const codeLines: string[] = [];
      const rawLines = [line];
      i++;
      while (i < lines.length && !closingFence.test(lines[i].trim())) {
        codeLines.push(lines[i]);
        rawLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        rawLines.push(lines[i]);
      }
      blocks.push(
        createBlock(index++, 'code', codeLines.join('\n'), {
          raw: rawLines.join('\n'),
          startLine: lineNumber,
          language,
        }),
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      blocks.push(
        createBlock(index++, 'heading', heading[2].trim(), {
          raw: line,
          level: heading[1].length,
          startLine: lineNumber,
        }),
      );
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      blocks.push(createBlock(index++, 'hr', '', { raw: line, startLine: lineNumber }));
      continue;
    }

    const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.+)$/.exec(line);
    if (listItem) {
      flushParagraph();
      const level = Math.floor(listItem[1].replace(/\t/g, '  ').length / 2);
      const ordered = /^\d+[.)]$/.test(listItem[2]);
      let content = listItem[3].trim();
      const checkbox = /^\[([ xX])\]\s+/.exec(content);
      let checked: boolean | undefined;
      if (checkbox) {
        checked = checkbox[1].toLowerCase() === 'x';
        content = content.slice(checkbox[0].length);
      }
      blocks.push(
        createBlock(index++, 'list-item', content, {
          raw: line,
          level,
          startLine: lineNumber,
          checked,
          ordered,
        }),
      );
      continue;
    }

    if (trimmed.startsWith('>')) {
      flushParagraph();
      const quoteLines = [trimmed.replace(/^>\s?/, '')];
      const rawLines = [line];
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith('>')) {
        i++;
        rawLines.push(lines[i]);
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
      }
      blocks.push(
        createBlock(index++, 'blockquote', quoteLines.join('\n'), {
          raw: rawLines.join('\n'),
          startLine: lineNumber,
        }),
      );
      continue;
    }

    if (isTableLine(trimmed)) {
      flushParagraph();
      const tableLines = [line];
      while (i + 1 < lines.length && isTableLine(lines[i + 1].trim())) {
        i++;
        tableLines.push(lines[i]);
      }
      blocks.push(
        createBlock(index++, 'table', tableLines.join('\n'), {
          raw: tableLines.join('\n'),
          startLine: lineNumber,
        }),
      );
      continue;
    }

    if (!buffer.length) {
      bufferStartLine = lineNumber;
    }
    buffer.push(line);
  }

  flushParagraph();
  return blocks;
}

export function groupPlanMarkdownBlocks(blocks: PlanMarkdownBlock[]): PlanMarkdownBlock[][] {
  const groups: PlanMarkdownBlock[][] = [];
  let currentList: PlanMarkdownBlock[] = [];

  for (const block of blocks) {
    if (block.type === 'list-item') {
      currentList.push(block);
      continue;
    }
    if (currentList.length) {
      groups.push(currentList);
      currentList = [];
    }
    groups.push([block]);
  }

  if (currentList.length) {
    groups.push(currentList);
  }

  return groups;
}

function createBlock(
  order: number,
  type: PlanMarkdownBlockType,
  content: string,
  options: Partial<PlanMarkdownBlock>,
): PlanMarkdownBlock {
  return {
    id: `plan-block-${order}`,
    type,
    content,
    raw: options.raw ?? content,
    level: options.level ?? 0,
    order,
    startLine: options.startLine ?? 1,
    language: options.language,
    checked: options.checked,
    ordered: options.ordered,
  };
}

function stripFrontmatter(markdown: string): string {
  const trimmed = markdown.trimStart();
  if (!trimmed.startsWith('---')) return markdown;
  const endIndex = trimmed.indexOf('\n---', 3);
  if (endIndex === -1) return markdown;
  return trimmed.slice(endIndex + 4).trimStart();
}

function isTableLine(trimmed: string): boolean {
  return trimmed.includes('|') && /^\|?.+\|.+\|?$/.test(trimmed);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
