import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const sourceMain = path.join(root, 'dist', 'main.js');
const targetMain = path.join(root, 'main.js');

if (!fs.existsSync(sourceMain)) {
	console.error('Build output not found: dist/main.js');
	process.exit(1);
}

fs.copyFileSync(sourceMain, targetMain);
console.log('Copied dist/main.js -> main.js');
