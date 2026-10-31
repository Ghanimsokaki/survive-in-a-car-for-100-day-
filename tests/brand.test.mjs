// The two things a reader of this repository should be able to verify in a
// second: the product is Gemby Games, and `npm start` really is this server.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};

console.log('\npackage.json is the server’s front door');
{
  const pkg = JSON.parse(read('package.json'));
  check('the package is Gemby Games', pkg.name === 'gemby-games', pkg.name);
  check('start runs the socket.io server', pkg.scripts.start === 'node server.js', pkg.scripts.start);
  check('main points at the same file', pkg.main === 'server.js', pkg.main);
  check('socket.io is a dependency', Boolean(pkg.dependencies['socket.io']), pkg.dependencies['socket.io']);
  check('express is a dependency', Boolean(pkg.dependencies.express), pkg.dependencies.express);
  check('they are runtime dependencies, not dev', !pkg.devDependencies?.['socket.io'] && !pkg.devDependencies?.express);
  check('ES modules, so server.js is one', pkg.type === 'module');
  check('a lockfile pins them', read('package-lock.json').includes('"socket.io"'));
}

console.log('\nserver.js — port, host, socket.io');
{
  const src = read('server.js');
  check('the port defaults to 8080', /const PORT = /.test(src) && src.includes('8080'),
    (src.match(/const PORT = .{0,24}/) || [''])[0]);
  check('it binds every interface', /const HOST = '0\.0\.0\.0'/.test(src),
    (src.match(/const HOST = .*/) || [''])[0]);
  check('it listens on that host and port', /server\.listen\(PORT,\s*HOST/.test(src));
  check('it speaks socket.io', /from 'socket\.io'/.test(src) && /new SocketServer\(/.test(src));
  check('it speaks express', /from 'express'/.test(src));
  check('CORS is open by default', /createCorsPolicy/.test(src) && !/CORS=strict.*default/i.test(src));
  check('the service calls itself Gemby Games', src.includes('gemby-games-realtime'));
  check('the boot banner says so', src.includes('GEMBY GAMES'));
}

console.log('\nthe front-end is Gemby Games');
{
  const html = read('public/index.html');
  check('the page title is the brand', /<title>Gemby Games/.test(html), (html.match(/<title>.*<\/title>/) || [''])[0]);
  check('the sign-in card says GEMBY GAMES', (html.match(/<h1>GEMBY GAMES<\/h1>/g) || []).length === 2);
  check('the old wordmark is gone', !/<h1>DAYS OUTRUN<\/h1>/.test(html));
  check('the logo mark is GG', (html.match(/class="logo-mark">GG</g) || []).length === 2);
  check('the run is still named', html.includes('100 DAYS OUTRUN'));
  check('the description sells the arcade', /content="Gemby Games/.test(html));
  check('the manifest is linked', /rel="manifest"/.test(html));

  const manifest = JSON.parse(read('public/manifest.webmanifest'));
  check('the installable app is Gemby Games', manifest.name.startsWith('Gemby Games'), manifest.name);
  check('…with a short name that fits a phone', manifest.short_name === 'Gemby Games', manifest.short_name);
  check('…and a description that names both games', /Iron Tide/.test(manifest.description));
  check('it still opens portrait-agnostic', manifest.orientation === 'any');
  check('it still ships icons', manifest.icons.length >= 2);

  const icon = read('public/icon.svg');
  check('the icon says GG, not 100', icon.includes('>GG</text>') && !icon.includes('>100</text>'));
  check('the maskable icon matches', read('public/icon-maskable.svg').includes('>GG</text>'));

  const arcade = read('public/js/arcade.js');
  check('the arcade header is the brand', arcade.includes('GEMBY GAMES'));
  check('the shelf still names its flagship game', arcade.includes("title: '100 DAYS OUTRUN'"));
  check('…and only ships two games', (arcade.match(/native: true/g) || []).length === 1);
}

console.log('\ndocs match reality');
{
  const readme = read('README.md');
  check('the README opens with the brand', readme.startsWith('# GEMBY GAMES'));
  check('…and names both games', readme.includes('100 Days Outrun') && readme.includes('Iron Tide'));
  check('the port in the docs is 8080', readme.includes('PORT || 8080') && !readme.includes('PORT || 3000'));
  check('CORS is documented as open', /CORS is open/.test(readme));
  check('the deploy guides agree', /CORS is \*\*open by default\*\*/.test(read('docs/DEPLOY-RENDER.md')));
}

console.log(problems.length ? `\nFAILED: ${problems.join(', ')}` : '\nALL BRAND + ENTRYPOINT TESTS PASSED');
process.exit(problems.length ? 1 : 0);
