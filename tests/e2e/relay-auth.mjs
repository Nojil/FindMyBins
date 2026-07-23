import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'fs';
const html = readFileSync('/Users/six47/Projects/FindMyBins/apps/app/public/native-auth.html', 'utf8');

async function run(query, label) {
  const vc = new VirtualConsole(); // swallow jsdom "navigation not implemented"
  const dom = new JSDOM(html, {
    url: 'https://find-my-bins-1ccbb963.base44.app/native-auth.html' + query,
    runScripts: 'dangerously', virtualConsole: vc,
  });
  await new Promise(r => setTimeout(r, 1500));
  const d = dom.window.document;
  return { href: d.getElementById('btn').getAttribute('href'), title: d.getElementById('title').textContent,
           msg: d.getElementById('msg').textContent, shown: d.getElementById('btn').style.display };
}

// 1. Normal: Base44 appends &access_token to our ?return_to
let r = await run('?return_to=exp%3A%2F%2F192.168.1.5%3A8081%2F--%2Fauth-callback&access_token=ABC123', 'normal');
console.log(r.href === 'exp://192.168.1.5:8081/--/auth-callback?access_token=ABC123'
  ? 'PASS builds correct app URL: ' + r.href : 'FAIL href=' + r.href);
console.log(r.shown === 'block' ? 'PASS tap-fallback button appears' : 'FAIL button hidden (' + r.shown + ')');

// 2. Token in fragment instead of query
r = await run('?return_to=findmybins%3A%2F%2Fauth-callback#access_token=FRAG9');
console.log(r.href === 'findmybins://auth-callback?access_token=FRAG9'
  ? 'PASS handles fragment token' : 'FAIL href=' + r.href);

// 3. Hostile return_to must be refused
r = await run('?return_to=https%3A%2F%2Fevil.example.com%2Fsteal&access_token=SECRET');
console.log(r.title.startsWith("Couldn't") && r.href === '#'
  ? 'PASS refuses non-app return address' : 'FAIL leaked to ' + r.href);

// 4. Missing token
r = await run('?return_to=exp%3A%2F%2F1.2.3.4%3A8081%2F--%2Fauth-callback');
console.log(r.title.startsWith("Couldn't") ? 'PASS reports missing token' : 'FAIL ' + r.title);
process.exit(0);
