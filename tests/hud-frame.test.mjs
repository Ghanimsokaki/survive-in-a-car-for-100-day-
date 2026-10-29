// Contract test for the phone HUD frame: the hotbar owns the bottom edge and
// nothing else is allowed to sit on top of it. Pure string checks against the
// stylesheet — enough to stop a future breakpoint from re-floating the hotbar
// into the middle of the screen (which is exactly what it used to do).
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const css = readFileSync(`${ROOT}public/styles.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const html = readFileSync(`${ROOT}public/index.html`, 'utf8');
const mainJs = readFileSync(`${ROOT}public/js/main.js`, 'utf8');

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};

/** Every `selector{...}` block, with the media query it lives in (null = global). */
function blocks(source) {
  const out = [];
  let media = null;
  const re = /@media([^{]+)\{|\}|([^{}@]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(source))) {
    if (m[0] === '}') { if (media) media = null; continue; }
    if (m[1]) { media = m[1].trim(); continue; }
    out.push({ media, selector: m[2].trim().replace(/\s+/g, ' '), body: m[3] });
  }
  return out;
}

const rules = blocks(css);
const phoneRules = rules.filter((r) => r.media && /pointer:coarse|max-width:820px|max-height:560px/.test(r.media));
// the authoritative frame is the portrait block that also fixes the hotbar
const frame = rules.filter((r) => r.selector === '#hotbar' && /bottom:calc\(6px/.test(r.body)).pop();
const frameMedia = frame?.media || '';
const inFrame = (selector) => phoneRules.filter((r) => r.selector === selector && r.media === frameMedia).pop();

console.log('\nphone hud frame');
{
  check('the frame block is a touch / narrow-screen query', /pointer:coarse|max-width:820px/.test(frameMedia), frameMedia);
  check('the hotbar is docked to the very bottom', /bottom:calc\(6px/.test(frame?.body || ''), frame?.body.slice(0, 70));
  check('the hotbar is not centred with a transform', /top:auto/.test(frame.body) && /transform:none/.test(frame.body));
  check('the hotbar never wraps to a second row', /flex-wrap:nowrap/.test(frame.body));
  check('the hotbar draws above the world', /z-index:1[0-9]/.test(frame.body));
  check('it comes last in the sheet so it wins the cascade',
    rules.filter((r) => r.selector === '#hotbar').pop() === frame
      || /gap:3px/.test(rules.filter((r) => r.selector === '#hotbar').pop().body), 'landscape only tweaks the gap');

  const slots = inFrame('#hotbar .hot-slot');
  check('slots shrink instead of overflowing', /flex:0 1/.test(slots?.body || '') && /min-width:0/.test(slots.body));

  const actions = inFrame('#actions');
  const actionsBottom = Number((actions?.body.match(/bottom:calc\((\d+)px/) || [])[1]);
  check('the action cluster is a grid', /display:grid/.test(actions?.body || ''));
  check('the action cluster sits above the hotbar', actionsBottom >= 46, `${actionsBottom}px`);

  const prompt = inFrame('#prompt');
  const promptBottom = Number((prompt?.body.match(/bottom:calc\((\d+)px/) || [])[1]);
  check('prompts sit above the action cluster', promptBottom > actionsBottom + 100, `${promptBottom}px`);

  const toasts = inFrame('#toasts');
  const toastsBottom = Number((toasts?.body.match(/bottom:calc\((\d+)px/) || [])[1]);
  check('toasts sit above the prompts', toastsBottom > promptBottom, `${toastsBottom} vs ${promptBottom}`);

  const fab = inFrame('.admin-fab');
  check('the owner chip is out of the action cluster', /left:calc\(6px/.test(fab?.body || '') && /bottom:calc\(140px/.test(fab.body));

  const diag = inFrame('#diag');
  const diagBottom = Number((diag?.body.match(/bottom:calc\((\d+)px/) || [])[1]);
  check('diagnostics share the cluster line, above the hotbar', diagBottom >= 46, `${diagBottom}px`);
}

console.log('\nlandscape frame');
{
  const landscape = phoneRules.filter((r) => /max-height:560px/.test(r.media));
  const pick = (selector) => landscape.filter((r) => r.selector === selector).pop();
  check('landscape shrinks the hotbar slots', /width:40px/.test(pick('#hotbar .hot-slot')?.body || ''));
  check('landscape puts all six buttons in one row', /repeat\(6,40px\)/.test(pick('#actions')?.body || ''));
  const hotbar = pick('#hotbar');
  check('landscape only tightens the gap, never re-docks the bar',
    !hotbar || /gap:3px/.test(hotbar.body), hotbar?.body || 'inherits the portrait frame');
  const promptRules = landscape.filter((r) => r.selector === '#prompt');
  check('landscape lifts the prompt clear of the cluster',
    promptRules.some((r) => /bottom:calc\(102px/.test(r.body)), `${promptRules.length} rules`);
}

console.log('\ninstalled app');
{
  const manifest = JSON.parse(readFileSync(`${ROOT}public/manifest.webmanifest`, 'utf8'));
  check('the manifest forces landscape', manifest.orientation === 'landscape', manifest.orientation);
  check('the manifest opens fullscreen', manifest.display === 'fullscreen', manifest.display);
  check('the manifest ships icons', Array.isArray(manifest.icons) && manifest.icons.length >= 2);
  check('the page links the manifest', /rel="manifest"/.test(html));
  check('Samsung/Chromium orientation hints are present',
    /name="screen-orientation" content="landscape"/.test(html));
}

console.log('\norientation');
{
  check('the run asks for fullscreen + landscape', /requestFullscreen/.test(mainJs) && /lock\('landscape'\)/.test(mainJs));
  check('the lock is best-effort, never blocking', /Promise\.race/.test(mainJs) && /catch \{\}/.test(mainJs));
  check('the rotate overlay can trigger the lock', /id="rotateLock"/.test(html));
  check('the overlay can still be dismissed', /id="rotateDismiss"/.test(html));
}

console.log(problems.length ? `\nFAILED: ${problems.join(', ')}` : '\nALL HUD FRAME TESTS PASSED');
process.exit(problems.length ? 1 : 0);
