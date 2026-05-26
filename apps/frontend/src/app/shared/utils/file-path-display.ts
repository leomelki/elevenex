export interface FilePathDisplayParts {
  dirname: string;
  basename: string;
}

export function splitFilePathForDisplay(filePath: string): FilePathDisplayParts {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  const basename = parts.pop() ?? filePath;
  return {
    dirname: parts.length ? parts.join('/') : '',
    basename,
  };
}
