// Standard edition text rules for every string the UI can put on screen (finding 31 and the crypto
// strip): no wallets, USDC, devnet, Solana or NFTs, no "Limited" editions, and the characters are
// Lunkers (UNIT_NOUN), never Pudgies; the bot family is never "Butcher-Bot". Code identifiers such as
// PudgyPreview or createPudgy are fine: only string literals are checked (comments are skipped).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FAMILY_DEFS, UNIT_NOUN } from '../../../shared/constants.ts';

const UI_DIR = fileURLToPath(new URL('..', import.meta.url));

const BANNED: { re: RegExp; why: string }[] = [
  { re: /Pudg(y|ies)/, why: 'the characters are Lunkers on screen (UNIT_NOUN)' },
  { re: /Butcher/i, why: 'the bot family is Dredge-Bot (FAMILY_DEFS.bot.name)' },
  { re: /wallet/i, why: 'no wallets in the standard edition' },
  { re: /usdc/i, why: 'no USDC prices' },
  { re: /devnet|mainnet/i, why: 'no chain networks' },
  { re: /solana/i, why: 'no Solana' },
  { re: /\bNFTs?\b/, why: 'no NFTs' },
  { re: /test tokens/i, why: 'no test-token notes' },
  { re: /\bLimited\b/, why: 'the rarity is Premium now' },
];

/** The only allowed hit: the uiSound union in types.ts is additive-only and still lists this kind. */
const ALLOWED = new Set(['types.ts:walletLinked']);

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'tests') out.push(...tsFiles(p));
    } else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Text of every string literal ('', "", and template literal text) in a TypeScript source, comments skipped. */
export function stringLiterals(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = src.length;
  const tplStack: number[] = []; // brace depth at each open template expression
  let depth = 0;
  const readQuoted = (q: string) => {
    let s = '';
    i++;
    while (i < n && src[i] !== q) {
      if (src[i] === '\\') {
        s += src[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (src[i] === '\n') break;
      s += src[i++];
    }
    i++;
    out.push(s);
  };
  const readTemplate = () => {
    // starts just after a backtick or a closing '}' of an expression; stops at '`' or '${'
    let s = '';
    while (i < n) {
      if (src[i] === '\\') {
        s += src[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (src[i] === '`') {
        i++;
        out.push(s);
        return;
      }
      if (src[i] === '$' && src[i + 1] === '{') {
        i += 2;
        out.push(s);
        tplStack.push(depth);
        depth++;
        return;
      }
      s += src[i++];
    }
    out.push(s);
  };
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2);
      i = i < 0 ? n : i + 2;
    } else if (c === "'" || c === '"') readQuoted(c);
    else if (c === '`') {
      i++;
      readTemplate();
    } else if (c === '{') {
      depth++;
      i++;
    } else if (c === '}') {
      depth--;
      i++;
      if (tplStack.length && tplStack[tplStack.length - 1] === depth) {
        tplStack.pop();
        readTemplate();
      }
    } else i++;
  }
  return out;
}

test('the literal scanner finds strings and skips comments and identifiers', () => {
  const lits = stringLiterals(`// Pudgy in a comment\nconst PudgyPreview = 'a'; /* wallet */ const t = \`x \${'y'} z\`; h("q\\"r");`);
  assert.deepEqual(lits, ['a', 'x ', 'y', ' z', 'q"r']);
});

test('no UI string mentions Pudgy, Butcher, wallets, USDC, devnet, Solana, NFTs or Limited', () => {
  const hits: string[] = [];
  for (const file of tsFiles(UI_DIR)) {
    const rel = relative(UI_DIR, file).replace(/\\/g, '/');
    for (const lit of stringLiterals(readFileSync(file, 'utf8'))) {
      for (const b of BANNED) {
        const m = lit.match(b.re);
        if (!m) continue;
        if (ALLOWED.has(`${rel}:${lit}`)) continue;
        hits.push(`${rel}: "${lit.slice(0, 80)}" (${b.why})`);
      }
    }
  }
  assert.deepEqual(hits, []);
});

test('the player-facing nouns come from the shared constants', () => {
  assert.equal(UNIT_NOUN.one, 'Lunker');
  assert.equal(UNIT_NOUN.many, 'Lunkers');
  assert.equal(FAMILY_DEFS.bot.name, 'Dredge-Bot');
});
