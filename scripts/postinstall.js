const { execSync } = require('child_process');
const { join } = require('path');
const root = join(__dirname, '..');

// Generate favicon assets from the canonical logo source
console.log('Generating Elevenex favicon assets...');
try {
  execSync('pnpm assets:icons', { cwd: root, stdio: 'inherit' });
} catch (e) {
  console.error('Failed to generate favicon assets:', e.message);
  process.exit(1);
}

console.log('Done.');
