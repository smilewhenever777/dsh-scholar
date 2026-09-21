import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(process.env.DSH_PLAYWRIGHT_PACKAGE ?? resolve(root, 'package.json'));
export const { chromium } = req('playwright');
export const deps = resolve(process.env.DSH_UI_DEPS ?? resolve(root, 'node_modules'));
export const launchOptions = { headless: true, ...(process.env.DSH_CHROME ? { executablePath: process.env.DSH_CHROME } : {}) };
