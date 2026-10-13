import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { parse as parseToml, stringify } from 'smol-toml';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { tomlTableRanges } from './toml-table-ranges.js';
import {
  atPath,
  record,
  type McpConfigRecord,
  type McpConfigSource,
} from './mcp-config.types.js';

export function revision(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value) ?? 'missing')
    .digest('hex');
}

/** Serializes each file's mutations; all reads and writes remain asynchronous. */
@Injectable()
export class McpConfigFileService {
  private readonly writes = new Map<string, Promise<unknown>>();

  async read(
    source: McpConfigSource,
  ): Promise<{ raw: string; root: McpConfigRecord }> {
    let raw: string;
    try {
      raw = await fs.readFile(source.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { raw: '', root: {} };
      throw error;
    }
    try {
      const errors: ParseError[] = [];
      const value: unknown =
        source.format === 'toml'
          ? parseToml(raw)
          : parse(raw, errors, {
              allowTrailingComma: source.format === 'jsonc',
              disallowComments: source.format === 'json',
            });
      const root = record(value);
      if (errors.length || !root)
        throw new Error('Expected a valid configuration object.');
      return { raw, root };
    } catch {
      throw new BadRequestException(
        `Cannot read ${source.path}. Fix its syntax before editing MCP servers.`,
      );
    }
  }

  async update(
    source: McpConfigSource,
    mutate: (root: McpConfigRecord) => { path: string[]; value: unknown }[],
  ): Promise<void> {
    // Dotfile managers commonly symlink these files. Keep the link intact and
    // serialize aliases of the same target through the same write queue.
    const path = await fs
      .realpath(source.path)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return source.path;
        throw error;
      });
    source = { ...source, path };
    const previous = this.writes.get(source.path) ?? Promise.resolve();
    const pending = previous
      .catch(() => undefined)
      .then(async () => {
        const { raw, root } = await this.read(source);
        const changes = mutate(root);
        let next = raw || (source.format !== 'toml' ? '{}\n' : '');
        for (const change of changes) {
          next =
            source.format !== 'toml'
              ? applyEdits(
                  next,
                  modify(next, change.path, change.value, {
                    formattingOptions: {
                      insertSpaces: true,
                      tabSize: 2,
                      eol: '\n',
                    },
                  }),
                )
              : this.editToml(next, change.path, change.value);
        }
        // Inline TOML tables are sealed: appending a child table can be invalid
        // even when the original document parsed. Validate before touching disk.
        if (source.format === 'toml') {
          try {
            parseToml(next);
          } catch {
            throw new BadRequestException(
              'This MCP table cannot be changed safely. Convert inline mcp_servers definitions to [mcp_servers.name] tables before editing.',
            );
          }
        }
        await fs.mkdir(dirname(source.path), { recursive: true });
        const temporary = `${source.path}.${randomUUID()}.tmp`;
        try {
          const mode = await fs
            .stat(source.path)
            .then((s) => s.mode & 0o777)
            .catch(() => 0o600);
          await fs.writeFile(temporary, next, { encoding: 'utf8', mode });
          // Do not replace a CLI/editor update that happened while preparing the write.
          const latest = await fs
            .readFile(source.path, 'utf8')
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return '';
              throw error;
            });
          if (latest !== raw)
            throw new ConflictException(
              'Configuration changed elsewhere. Refresh and try again.',
            );
          await fs.rename(temporary, source.path);
        } finally {
          await fs.rm(temporary, { force: true });
        }
      });
    this.writes.set(source.path, pending);
    try {
      await pending;
    } finally {
      if (this.writes.get(source.path) === pending)
        this.writes.delete(source.path);
    }
  }

  /** Replace only the selected MCP table, preserving the rest of the TOML verbatim. */
  private editToml(raw: string, path: string[], value: unknown): string {
    const root = parseToml(raw);
    const [collection, name] = path;
    if (path.length !== 2)
      throw new Error('MCP TOML edits must target a server table.');
    const ranges = tomlTableRanges(raw).filter(
      (table) => atPath(table.header, [collection, name]) !== undefined,
    );
    // Inline/dotted definitions cannot be safely patched as table blocks.
    if (atPath(root, path) !== undefined && !ranges.length)
      throw new BadRequestException(
        'This MCP server uses inline TOML. Convert it to a [mcp_servers.name] table before editing.',
      );
    let next = raw;
    for (const range of ranges.reverse())
      next = next.slice(0, range.start) + next.slice(range.end);
    if (value !== undefined)
      next = `${next.trimEnd()}\n\n${stringify({ [collection]: { [name]: value } })}`;
    return next.replace(/^\n+/, '');
  }
}
