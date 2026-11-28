const { copyFileSync, existsSync, lstatSync, readdirSync, rmSync } = require("fs");
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

// Patchright's npm packages omit the Apache-2.0 LICENSE and the NOTICE that
// Playwright's license requires redistributions to retain. Restore both from
// the repository copies wherever the browser driver is staged.
const DRIVER_LICENSE_ROOT = join(__dirname, "third-party", "patchright");
function restoreDriverLicenses(nodeModulesRoot) {
  for (const name of ["patchright", "patchright-core"]) {
    const packageRoot = join(nodeModulesRoot, name);
    if (!existsSync(join(packageRoot, "package.json"))) continue;
    for (const file of ["LICENSE", "NOTICE"]) {
      if (!existsSync(join(packageRoot, file)))
        copyFileSync(join(DRIVER_LICENSE_ROOT, file), join(packageRoot, file));
    }
  }
}

module.exports = {
  getDirectorySize,
  formatSize,
  removeGitArtifacts,
  restoreDriverLicenses,
};
