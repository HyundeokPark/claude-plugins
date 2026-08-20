#!/usr/bin/env node
/**
 * tools/bump.mjs — 플러그인 버전을 한 번에 올린다.
 *
 * 왜: 버전 숫자를 손으로 고쳐야 하는 곳이 셋이다.
 *   1) .claude-plugin/marketplace.json 의 해당 플러그인 항목
 *   2) plugins/<name>/.claude-plugin/plugin.json
 *   3) plugins/<name>/scripts/*.js 의 `const *_VERSION = '...'`
 * 실제로 8/14 이후 세 번 릴리스하는 동안 1)만 계속 빠져 1.10.0 에 멈춰 있었다.
 * 이 기기는 2)를 보고 설치해서 안 드러났지만, 다른 기기는 마켓플레이스 목록을 보고
 * 낡은 버전을 최신으로 받았다. 사람 기억에 맡길 일이 아니다.
 *
 * Usage:
 *   node tools/bump.mjs 1.13.0            # 지정한 버전으로
 *   node tools/bump.mjs patch|minor|major # 현재(plugin.json) 기준 증가
 *   node tools/bump.mjs --check           # 안 고치고 어긋난 곳만 보고 (테스트가 쓴다)
 *   node tools/bump.mjs 1.13.0 --plugin lake
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKETPLACE = path.join(ROOT, '.claude-plugin', 'marketplace.json');
// 버전 상수만 잡는다. 다른 대문자 상수를 건드리면 안 된다.
const VERSION_CONST_RE = /^(\s*const\s+[A-Z0-9_]*VERSION\s*=\s*')([^']*)(';?)$/m;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));
const writeJson = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n', 'utf-8');

/** 한 플러그인의 버전이 적힌 모든 자리. 각 자리는 현재 값을 읽을 수 있어야 한다. */
function sites(name) {
  const dir = path.join(ROOT, 'plugins', name);
  const out = [];

  const pj = path.join(dir, '.claude-plugin', 'plugin.json');
  if (fs.existsSync(pj)) {
    out.push({ kind: 'plugin.json', get: () => readJson(pj).version });
  }

  if (fs.existsSync(MARKETPLACE)) {
    const has = (readJson(MARKETPLACE).plugins || []).some((p) => p.name === name);
    if (has) {
      out.push({
        kind: 'marketplace.json',
        get: () => ((readJson(MARKETPLACE).plugins || []).find((p) => p.name === name) || {}).version,
      });
    }
  }

  const scriptsDir = path.join(dir, 'scripts');
  if (fs.existsSync(scriptsDir)) {
    const files = fs.readdirSync(scriptsDir).filter((f) => f.endsWith('.js')).sort();
    for (const f of files) {
      const file = path.join(scriptsDir, f);
      const m = fs.readFileSync(file, 'utf-8').match(VERSION_CONST_RE);
      if (!m) continue;
      const constName = m[0].trim().split(/\s+/)[1];
      out.push({
        kind: `${f}:${constName}`,
        file,
        get: () => {
          const mm = fs.readFileSync(file, 'utf-8').match(VERSION_CONST_RE);
          return mm ? mm[2] : undefined;
        },
      });
    }
  }
  return out;
}

function applyVersion(name, version) {
  const pj = path.join(ROOT, 'plugins', name, '.claude-plugin', 'plugin.json');
  if (fs.existsSync(pj)) {
    const o = readJson(pj);
    o.version = version;
    writeJson(pj, o);
  }
  if (fs.existsSync(MARKETPLACE)) {
    const o = readJson(MARKETPLACE);
    let touched = false;
    for (const p of o.plugins || []) {
      if (p.name === name) { p.version = version; touched = true; }
    }
    if (touched) writeJson(MARKETPLACE, o);
  }
  for (const s of sites(name)) {
    if (!s.file) continue;
    const body = fs.readFileSync(s.file, 'utf-8');
    fs.writeFileSync(s.file, body.replace(VERSION_CONST_RE, `$1${version}$3`), 'utf-8');
  }
}

function pluginNames(argv) {
  const i = argv.indexOf('--plugin');
  if (i >= 0 && argv[i + 1]) return [argv[i + 1]];
  const dir = path.join(ROOT, 'plugins');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

function bumpSemver(cur, kind) {
  const [a, b, c] = String(cur).split('.').map(Number);
  if (kind === 'major') return `${a + 1}.0.0`;
  if (kind === 'minor') return `${a}.${b + 1}.0`;
  return `${a}.${b}.${c + 1}`;
}

const argv = process.argv.slice(2);
const pluginArg = argv.indexOf('--plugin') >= 0 ? argv[argv.indexOf('--plugin') + 1] : null;
const target = argv.find((a) => !a.startsWith('--') && a !== pluginArg);
const check = argv.includes('--check');

let bad = 0;
let acted = 0;

for (const name of pluginNames(argv)) {
  const found = sites(name);
  if (!found.length) continue;
  acted++;

  if (check) {
    const vals = found.map((s) => s.get());
    const uniq = [...new Set(vals)];
    if (uniq.length === 1) {
      console.log(`ok ${name} ${uniq[0]} (${found.length} sites)`);
    } else {
      bad++;
      console.log(`MISMATCH ${name}`);
      found.forEach((s, i) => console.log(`  ${vals[i]}  ${s.kind}`));
    }
    continue;
  }

  if (!target) {
    console.error('usage: node tools/bump.mjs <x.y.z|patch|minor|major> [--plugin <name>]   |   --check');
    process.exit(2);
  }

  const cur = (found.find((s) => s.kind === 'plugin.json') || {}).get?.() || '0.0.0';
  const next = SEMVER_RE.test(target) ? target : bumpSemver(cur, target);
  if (!SEMVER_RE.test(next)) {
    console.error(`bad version: ${target}`);
    process.exit(2);
  }
  applyVersion(name, next);
  console.log(`${name}: ${cur} -> ${next}`);
  for (const s of sites(name)) console.log(`  ${s.get()}  ${s.kind}`);
}

if (!acted) {
  console.error('no plugins found under plugins/');
  process.exit(2);
}
process.exit(bad ? 1 : 0);
