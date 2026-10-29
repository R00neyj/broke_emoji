"""Regression checks using actual browser Canvas/PNG, without app/gallery I/O.

Run with Python + Playwright already installed on the development machine.
"""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
source = (ROOT / 'src/main.js').read_text(encoding='utf-8')
processing = source[source.index('const canvasOf ='):source.index('async function importBlobs')]
composite = source[source.index('function composite('):source.index('async function copyImage')]

with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=True)
    page = browser.new_page()
    page.add_script_tag(content=(ROOT / 'src/imaging.js').read_text(encoding='utf-8'))
    page.add_script_tag(content='const { removeBackground, alphaBBox, fitBox } = window.imaging; const STORE_MAX = 360; let settings;\n' + processing + composite)
    results = page.evaluate('''async () => {
      const results = [];
      function check(ok, message) { if (!ok) throw new Error(message); }
      async function run(name, fit, removeBg, width, height, transparent, expected) {
        settings = {fit, removeBg, tol: 0, size: 120, pad: 10, bg: '#bacee0'};
        const input = canvasOf(width, height), ctx = input.getContext('2d');
        if (!transparent) { ctx.fillStyle = settings.bg; ctx.fillRect(0,0,width,height); }
        ctx.fillStyle = '#1e2633'; ctx.fillRect(20,15,55,40);
        const blob = await new Promise(r => input.toBlob(r, 'image/png'));
        const output = await createImageBitmap(new Blob([await processImage(blob)], {type:'image/png'}));
        check(output.width === expected[0] && output.height === expected[1], `${name}: dimensions ${output.width}x${output.height}`);
        const decoded = canvasOf(output.width, output.height);
        decoded.getContext('2d').drawImage(output,0,0);
        const pixels = decoded.getContext('2d').getImageData(0,0,output.width,output.height).data;
        if (fit === 'original') {
          check(pixels[(15*width+20)*4] === 30, `${name}: subject moved`);
          check(pixels[(15*width+19)*4+3] === (removeBg || transparent ? 0 : 255), `${name}: left margin lost`);
          check(pixels[(55*width+20)*4+3] === (removeBg || transparent ? 0 : 255), `${name}: bottom margin lost`);
          const image = new Image();
          image.src = decoded.toDataURL(); await image.decode();
          const copied = composite(image);
          check(copied.width === width && copied.height === height, `${name}: copy dimensions`);
          const out = copied.getContext('2d').getImageData(0,0,width,height).data;
          const expectedCanvas = canvasOf(width,height), ec = expectedCanvas.getContext('2d');
          ec.fillStyle = settings.bg; ec.fillRect(0,0,width,height); ec.drawImage(input,0,0);
          const reference = ec.getImageData(0,0,width,height).data;
          check(out.every((v,i) => v === reference[i]), `${name}: copy changed pixels/margins`);
        }
        output.close(); results.push({name, dimensions:expected, pass:true});
      }
      await run('original, opaque margins', 'original', false, 120, 96, false, [120,96]);
      await run('original, background removal on', 'original', true, 120, 96, false, [120,96]);
      await run('original, transparent margins', 'original', true, 140, 90, true, [140,90]);
      await run('original, larger than storage cap', 'original', false, 900, 500, false, [900,500]);
      await run('original, large with background removal', 'original', true, 900, 500, false, [900,500]);
      await run('contain still trims', 'contain', true, 120, 96, false, [55,40]);
      await run('cover still trims', 'cover', true, 120, 96, false, [55,40]);
      await run('contain still caps at 360', 'contain', false, 900, 500, false, [360,200]);
      await run('cover still caps at 360', 'cover', false, 900, 500, false, [360,200]);
      return results;
    }''')
    browser.close()
print(json.dumps(results, ensure_ascii=False, indent=2))
