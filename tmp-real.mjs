import { readFile } from 'node:fs/promises';
const base = 'http://127.0.0.1:8787';
const index = await readFile('C:/Users/chiaki/AppData/Local/Temp/rk/app.html', 'utf8').catch(() => null);
console.log(index ? 'read ok' : 'no file');
