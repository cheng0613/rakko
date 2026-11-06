const base = 'http://127.0.0.1:8787';
const index = await (await import('node:fs/promises')).readFile('C:/Users/chiaki/Desktop/Rakko/tmp-index.html', 'utf8');
const created = await fetch(base + '/v1/apps', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: '运行体检', description: '看运行、筛失败、留草稿', files: { 'index.html': index } }),
});
const app = await created.json();
console.log('建应用:', created.status, app.name, 'files:', Object.keys(app.files || {}));
const page = await fetch(base + '/app/' + encodeURIComponent(app.name) + '/');
const html = await page.text();
console.log('托管:', page.status, '长度', html.length, 'tokens:', html.includes('/tokens.css'), 'runtime:', html.includes('/app-runtime.js'));
const kvPut = await fetch(base + '/app-api/kv/' + encodeURIComponent(app.name) + '/note', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: '草稿测试' }),
});
console.log('kv 写:', kvPut.status, JSON.stringify(await (await fetch(base + '/app-api/kv/' + encodeURIComponent(app.name) + '/note')).json()));
