// Screenshots of the real Vowe room in Chromium (no Electron), through the room harness. Needs the dev
// server running on the built dir (scripts/system-canvas/serve.mjs) and room-harness.html built into it.
//
//   node scripts/system-canvas/room-harness/shoot.mjs --base http://127.0.0.1:4895 --out <dir> [--scale 2] [--only name]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const base = arg('--base', 'http://127.0.0.1:4895');
const out = path.resolve(arg('--out', 'room-shots'));
const scale = Number(arg('--scale', '1'));
const only = arg('--only', null);
fs.mkdirSync(out, { recursive: true });

/** Each shot: a name, the theme, the window size, and what to do before taking it. */
const SHOTS = [
  { name: 'room-light', theme: 'light', size: [1440, 900] },
  { name: 'room-dark', theme: 'dark', size: [1440, 900] },
  { name: 'system-light', theme: 'light', size: [1440, 900], act: system },
  { name: 'system-selected-light', theme: 'light', size: [1440, 900], act: async (p) => { await system(p); await select(p, 'Canvas client'); } },
  { name: 'system-evidence-light', theme: 'light', size: [1440, 900], act: async (p) => { await system(p); await select(p, 'Canvas client'); await evidence(p); } },
  { name: 'system-dark', theme: 'dark', size: [1440, 900], act: async (p) => { await system(p); await select(p, 'Supabase database'); } },
  { name: 'system-1024', theme: 'light', size: [1024, 768], act: system },
];

async function system(p) {
  await p.getByRole('button', { name: 'System', exact: true }).first().click();
  await p.waitForSelector('.sc-room .stage svg .n', { timeout: 30000 });
  await p.waitForTimeout(900);
}
async function select(p, name) {
  await p.locator('.sc-room .n', { hasText: name }).first().click({ position: { x: 30, y: 14 } });
  await p.waitForTimeout(500);
}
async function evidence(p) {
  const b = p.locator('.sc-panel .ev-open').first();
  if (await b.count()) { await b.click(); await p.waitForTimeout(1200); }
}

const browser = await chromium.launch();
for (const s of SHOTS) {
  if (only && s.name !== only) continue;
  const page = await browser.newPage({ viewport: { width: s.size[0], height: s.size[1] }, deviceScaleFactor: scale, colorScheme: s.theme });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${base}/renderer/room-harness.html?theme=${s.theme}#/room/room-voice`);
  await page.waitForSelector('.surface .seg button', { timeout: 20000 });
  await page.waitForTimeout(1200);
  try { await s.act?.(page); } catch (e) { errors.push(`act: ${e.message}`); }
  const file = path.join(out, `${s.name}.png`);
  await page.screenshot({ path: file });
  console.log(file, errors.length ? `errors: ${errors.slice(0, 4).join(' | ')}` : '');
  await page.close();
}
await browser.close();
