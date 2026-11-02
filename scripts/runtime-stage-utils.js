const { lstatSync, readdirSync, rmSync } = require("fs");
const { join } = require("path");

// Shared backend packaging helpers, independent of optional product assets.
function getDirectorySize(root) {
  let stat;
  try {
    stat = lstatSync(root);
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  if (stat.isSymbolicLink()) return 0;
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(root).reduce(
    (size, name) => size + getDirectorySize(join(root, name)),
    0,
  );
}

function formatSize(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function removeGitArtifacts(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const target = join(root, entry.name);
    if (entry.name === ".git") rmSync(target, { recursive: true, force: true });
    else if (entry.isDirectory()) removeGitArtifacts(target);
  }
}

module.exports = { getDirectorySize, formatSize, removeGitArtifacts };
