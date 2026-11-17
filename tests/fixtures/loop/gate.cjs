'use strict';
/**
 * Stub gate. rows.txt maps a row id to its file: `T1 r1`. `node gate.cjs T1` exits 0 when r1.txt reads `ok`;
 * `node gate.cjs` (no row) checks every row. GATE_PAD adds that many dots of output (the cap test).
 */
const fs = require('fs');
const map = Object.fromEntries(fs.readFileSync('rows.txt', 'utf8').split(/\r?\n/).filter(Boolean).map((l) => l.trim().split(/\s+/)));
const rows = process.argv[2] ? [process.argv[2]] : Object.keys(map);
const bad = rows.filter((r) => { try { return fs.readFileSync(`${map[r] || r}.txt`, 'utf8').trim() !== 'ok'; } catch (_) { return true; } });
process.stdout.write(`gate: ${rows.length - bad.length} of ${rows.length} rows pass\n${'.'.repeat(Number(process.env.GATE_PAD || 0))}\n`);
if (bad.length) { process.stdout.write(`FAIL ${bad.map((r) => { let got = '(missing)'; try { got = fs.readFileSync(`${map[r] || r}.txt`, 'utf8').trim().slice(0, 40); } catch (_) { /* missing */ } return `${r} (got ${JSON.stringify(got)})`; }).join(', ')}\n`); process.exit(1); }
