import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const distDir = path.join(__dirname, '..', '..', 'dist');
console.log('Cleaning previous build...');
try {
  fs.rmSync(distDir, { recursive: true, force: true });
} catch (err) {
  // Ignore "directory does not exist" errors
  console.log(err);
}

fs.mkdirSync(distDir, { recursive: true });
fs.mkdirSync(path.join(distDir, 'logs'), { recursive: true });
console.log('dist and dist/logs directories created/confirmed');

console.log('Compiling TypeScript...');
execSync('tsc', { stdio: 'inherit' });

console.log('Copying config files...');
const configSourcePath = path.join(__dirname, '..', 'mcp', 'stdio-config.json');
const configDestPath = path.join(distDir, 'mcp', 'stdio-config.json');

try {
  fs.mkdirSync(path.dirname(configDestPath), { recursive: true });

  if (fs.existsSync(configSourcePath)) {
    fs.copyFileSync(configSourcePath, configDestPath);
    console.log(`Copied stdio-config.json to ${configDestPath}`);
  } else {
    console.error(`Error: config file not found: ${configSourcePath}`);
  }
} catch (error) {
  console.error('Error copying config file:', error);
}

console.log('Preparing package.json...');
const packageJson = require('../../package.json');

const readmeContent = `# ${packageJson.name}

Native Messaging host for the HumanChrome Chrome extension.

## Installation

1. Make sure Node.js is installed.
2. Install globally:
   \`\`\`
   npm install -g ${packageJson.name}
   \`\`\`
3. Register the Native Messaging host:
   \`\`\`
   # User-level install (recommended)
   ${packageJson.name} register

   # If user-level install fails, try a system-level install
   ${packageJson.name} register --system
   # Or with admin privileges
   sudo ${packageJson.name} register
   \`\`\`

## Usage

The Chrome extension launches this host automatically; no manual run is required.
`;

fs.writeFileSync(path.join(distDir, 'README.md'), readmeContent);

console.log('Copying wrapper scripts...');
const scriptsSourceDir = path.join(__dirname, '.');
const macOsWrapperSourcePath = path.join(scriptsSourceDir, 'run_host.sh');
const windowsWrapperSourcePath = path.join(scriptsSourceDir, 'run_host.bat');

const macOsWrapperDestPath = path.join(distDir, 'run_host.sh');
const windowsWrapperDestPath = path.join(distDir, 'run_host.bat');

try {
  if (fs.existsSync(macOsWrapperSourcePath)) {
    fs.copyFileSync(macOsWrapperSourcePath, macOsWrapperDestPath);
    console.log(`Copied ${macOsWrapperSourcePath} to ${macOsWrapperDestPath}`);
  } else {
    console.error(`Error: macOS wrapper script not found: ${macOsWrapperSourcePath}`);
  }

  if (fs.existsSync(windowsWrapperSourcePath)) {
    fs.copyFileSync(windowsWrapperSourcePath, windowsWrapperDestPath);
    console.log(`Copied ${windowsWrapperSourcePath} to ${windowsWrapperDestPath}`);
  } else {
    console.error(`Error: Windows wrapper script not found: ${windowsWrapperSourcePath}`);
  }
} catch (error) {
  console.error('Error copying wrapper scripts:', error);
}

console.log('Setting executable permissions...');
const filesToMakeExecutable = ['index.js', 'cli.js', 'run_host.sh'];

filesToMakeExecutable.forEach((file) => {
  const filePath = path.join(distDir, file);
  try {
    if (fs.existsSync(filePath)) {
      fs.chmodSync(filePath, '755');
      console.log(`Set executable permissions (755) on ${file}`);
    } else {
      console.warn(`Warning: ${filePath} not found; cannot set executable permissions`);
    }
  } catch (error) {
    console.error(`Error setting executable permissions on ${file}:`, error);
  }
});

// Write node_path.txt immediately after build to ensure Chrome uses the correct Node.js version.
// This is critical for development mode where dist is deleted on each rebuild.
// The file points to the same Node.js that compiled the native modules (better-sqlite3 etc.)
console.log('Writing node_path.txt...');
const nodePathFile = path.join(distDir, 'node_path.txt');
fs.writeFileSync(nodePathFile, process.execPath, 'utf8');
console.log(`Wrote Node.js path: ${process.execPath}`);

console.log('✅ Build complete');
