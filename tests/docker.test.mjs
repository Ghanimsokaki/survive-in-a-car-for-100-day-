// The Hugging Face Spaces container: the Dockerfile exactly as specified, the
// port the Space actually routes to, and the context hygiene around it.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PORT, SPACES_PORT, isHuggingFaceSpace, resolvePort,
} from '../lib/port.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};

// ------------------------------------------------------------------ file ---
console.log('\nDockerfile');
{
  check('it is at the repository root, with no extension', existsSync(path.join(root, 'Dockerfile')));
  const raw = read('Dockerfile');
  const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const expected = [
    'FROM node:18',
    'WORKDIR /app',
    'COPY package*.json ./',
    'RUN npm install',
    'COPY . .',
    'EXPOSE 7860',
    'CMD ["node", "server.js"]',
  ];
  check('it is exactly the requested instructions, in order',
    JSON.stringify(lines) === JSON.stringify(expected),
    JSON.stringify(lines));
  check('it pins node 18', lines[0] === 'FROM node:18');
  check('it exposes the Space port', lines.includes('EXPOSE 7860'));
  check('it starts the room server', lines[lines.length - 1] === 'CMD ["node", "server.js"]');
  check('package.json is copied before the install layer',
    lines.indexOf('COPY package*.json ./') < lines.indexOf('RUN npm install'),
    'so a source edit does not re-install');
  check('there is no shell wrapper around the start command', !/CMD node server\.js/.test(raw));
}

console.log('\nbuild context');
{
  const ignore = read('.dockerignore');
  const rules = ignore.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  check('.dockerignore keeps the host node_modules out', rules.includes('node_modules'),
    'the image installs its own');
  check('…and local secrets', rules.includes('.env') && rules.includes('.env.*'));
  check('…and git metadata', rules.includes('.git'));
  check('the game source is still copied', !rules.includes('public') && !rules.includes('server.js'));
  check('the port module ships too', existsSync(path.join(root, 'lib/port.mjs')));
}

// ------------------------------------------------------------------ port ---
console.log('\nthe port a Space routes to');
{
  check('7860 is the Spaces port', SPACES_PORT === 7860);
  check('8080 stays the local default', DEFAULT_PORT === 8080);

  check('a plain laptop gets 8080', resolvePort({}) === 8080);
  check('an assigned PORT wins', resolvePort({ PORT: '3000' }) === 3000);
  check('…even inside a Space', resolvePort({ PORT: '9000', SPACE_ID: 'user/space' }) === 9000);
  check('a Space without PORT gets 7860', resolvePort({ SPACE_ID: 'user/space' }) === 7860);
  check('SPACE_HOST is enough to detect a Space', resolvePort({ SPACE_HOST: 'x.hf.space' }) === 7860);
  check('SPACE_REPO_NAME is enough too', resolvePort({ SPACE_REPO_NAME: 'gemby-games' }) === 7860);
  check('a junk PORT falls back instead of crashing',
    resolvePort({ PORT: 'soon' }) === 8080 && resolvePort({ PORT: '-1' }) === 8080 &&
    resolvePort({ PORT: '99999' }) === 8080);
  check('an empty PORT is not treated as 0', resolvePort({ PORT: '' }) === 8080);
  check('the detector says what it means',
    isHuggingFaceSpace({ SPACE_ID: 'a/b' }) === true && isHuggingFaceSpace({}) === false);
}

console.log('\nthe server and the README agree');
{
  const src = read('server.js');
  check('server.js asks lib/port.mjs', /resolvePort\(/.test(src) && /from '\.\/lib\/port\.mjs'/.test(src));
  check('…and still binds every interface', /const HOST = '0\.0\.0\.0'/.test(src));
  check('…and says so in the log when it is on a Space', src.includes('Hugging Face Space'));

  const readme = read('README.md');
  check('the README carries Space metadata at the top', /^---\ntitle: Gemby Games[\s\S]*?sdk: docker[\s\S]*?app_port: 7860[\s\S]*?---\n/.test(readme));
  check('…under the Gemby Games name', /title: Gemby Games/.test(readme));
  check('the Dockerfile is quoted in the docs', readme.includes('CMD ["node", "server.js"]'));
  check('the Space guide exists', readFileSync(path.join(root, 'docs/DEPLOY-HF.md'), 'utf8').includes('7860'));
  check('package.json still starts the same way', JSON.parse(read('package.json')).scripts.start === 'node server.js');
}

console.log(problems.length ? `\nFAILED: ${problems.join(', ')}` : '\nALL DOCKER / SPACES TESTS PASSED');
process.exit(problems.length ? 1 : 0);
