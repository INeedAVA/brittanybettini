// Combines src/*.gs into dist/INAVA_Assist.gs so the whole bot can be pasted
// into the Apps Script editor as a single file. Run: node build.js
'use strict';

const fs = require('fs');
const path = require('path');

const ORDER = ['Config', 'Sheets', 'Access', 'Knowledge', 'Claude', 'ChatApi', 'Tickets', 'Main', 'Setup'];
const src = path.join(__dirname, 'src');
const files = fs.readdirSync(src).filter((f) => f.endsWith('.gs')).map((f) => f.slice(0, -3));
const missing = files.filter((f) => ORDER.indexOf(f) < 0);
if (missing.length) throw new Error('Add to ORDER in build.js: ' + missing.join(', '));

const header = '// INAVA Assist - generated from src/ by build.js. Edit the files in src/, not this one.\n';
const body = ORDER.map((f) => '\n// ===== ' + f + '.gs =====\n\n' + fs.readFileSync(path.join(src, f + '.gs'), 'utf8')).join('');
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist', 'INAVA_Assist.gs'), header + body);
fs.copyFileSync(path.join(src, 'appsscript.json'), path.join(__dirname, 'dist', 'appsscript.json'));
console.log('Wrote dist/INAVA_Assist.gs and dist/appsscript.json');
