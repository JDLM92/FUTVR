import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { devLogin, openSample, pitchPoint, tapPitch } from './helpers';
import { emptyPitchPng } from './pitch-fixture';

test('dense JPEG crops stay within the API limit with matching upload and preview formats', async ({ page }) => {
  test.setTimeout(90_000);
  let uploaded: { size: number; type: string; name: string; hash: string } | undefined;
  await page.route('**/auth/guest', route => route.fulfill({
    json: { accessToken: 'transport-test', user: { id: 'transport-test', email: null, isAnonymous: true } },
    headers: { 'Access-Control-Allow-Origin': '*' },
  }));
  await page.route('**/analyses', async route => {
    const form = await new Response(route.request().postDataBuffer(), {
      headers: { 'Content-Type': route.request().headers()['content-type'] },
    }).formData();
    const file = form.get('file') as File;
    uploaded = { size: file.size, type: file.type, name: file.name, hash: createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex') };
    await route.fulfill({ status: 202, json: {
      id: 'transport-test', status: 'completed', result: { detections: [], calibration: { status: 'unavailable' } },
    }, headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  await page.goto('/');
  // A reproducible, high-detail fixture demonstrates JPEG-to-PNG expansion in
  // the actual browser encoder; this does not call the detector or cloud API.
  const input = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 2560;
    const context = canvas.getContext('2d')!;
    const pixels = context.createImageData(canvas.width, canvas.height);
    let seed = 42;
    const byte = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed & 255; };
    for (let i = 0; i < pixels.data.length; i += 4) {
      pixels.data[i] = byte(); pixels.data[i + 1] = byte(); pixels.data[i + 2] = byte(); pixels.data[i + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    const jpeg = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/jpeg', .85));
    const decoded = await createImageBitmap(jpeg);
    context.drawImage(decoded, 0, 0); decoded.close();
    const expanded = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'));
    const dataURL = await new Promise<string>(resolve => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(jpeg);
    });
    return { bytes: jpeg.size, expandedBytes: expanded.size, base64: dataURL.split(',')[1] };
  });
  expect(input.bytes).toBeLessThan(20 * 1024 * 1024);
  expect(input.expandedBytes).toBeGreaterThan(10 * 1024 * 1024);
  await page.getByLabel('Upload match screenshot').setInputFiles({ name: 'dense-frame.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(input.base64, 'base64') });
  await page.getByRole('button', { name: 'Full image', exact: true }).click();
  await page.getByRole('button', { name: 'Create tactical board' }).click();
  await expect(page.getByRole('heading', { name: 'Does the pitch line up?' })).toBeVisible();
  expect(uploaded?.size).toBeLessThanOrEqual(10 * 1024 * 1024);
  expect(uploaded?.type).toBe('image/jpeg');
  expect(uploaded?.name).toBe('match-frame.jpg');
  const preview = await page.locator('.source-canvas image').getAttribute('href');
  expect(preview?.startsWith('data:image/jpeg;base64,')).toBe(true);
  const previewHash = createHash('sha256').update(Buffer.from(preview!.split(',')[1], 'base64')).digest('hex');
  expect(previewHash).toBe(uploaded?.hash);
});

async function actorX(page: Parameters<typeof openSample>[0], id: string) {
  return Number((await page.locator(`[data-actor="${id}"]`).getAttribute('transform'))?.match(/translate\(([^ ]+)/)?.[1]);
}

test('guest edit, undo, authored movement, email claim, immutable publication and anchored discussion',async({page,browser,request})=>{
  await openSample(page);
  await page.locator('[data-actor="sample-a3"]').click();
  await expect(page.getByLabel('Player name')).toBeVisible();
  await page.getByLabel('Player name').fill('Alex playmaker');
  await expect(page.locator('[data-actor="sample-a3"]')).toHaveAttribute('aria-label','Alex playmaker');

  await page.getByRole('button',{name:'Arrow tool'}).click();
  await tapPitch(page,44,31);await tapPitch(page,72,22);
  await expect(page.locator('[data-annotation]')).toHaveCount(1);
  await page.getByRole('button',{name:'Undo last edit'}).click();
  await expect(page.locator('[data-annotation]')).toHaveCount(0);
  await tapPitch(page,44,31);await tapPitch(page,72,22);
  await expect(page.locator('[data-annotation]')).toHaveCount(1);

  await page.getByRole('button',{name:'Add step'}).click();
  await expect(page.getByText('Editing step 2',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Select tool'}).click();
  const player=page.locator('[data-actor="sample-a3"]');
  const origin=await pitchPoint(page,43,30),destination=await pitchPoint(page,58,35);
  await page.mouse.move(origin.x,origin.y);await page.mouse.down();await page.mouse.move(destination.x,destination.y,{steps:8});await page.mouse.up();
  await expect.poll(()=>actorX(page,'sample-a3')).toBeCloseTo(58,3);
  await page.locator('.frame-card').first().click();
  await expect(player).toHaveAttribute('transform','translate(43 30)');
  await page.locator('.frame-card').nth(1).click();
  await expect.poll(()=>actorX(page,'sample-a3')).toBeCloseTo(58,3);

  await page.getByLabel('Play title').fill('E2E authored passing lane');
  const saveResponse=page.waitForResponse(response=>response.request().method()==='PUT'&&/\/api\/drafts\/[^/?]+$/.test(response.url()));
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await devLogin(page,'owner');
  const saved=await saveResponse;
  expect(saved.status()).toBe(200);
  const draft=await saved.json();
  expect(draft.actors.find((actor:{id:string})=>actor.id==='sample-a3').name).toBe('Alex playmaker');
  expect(draft.keyframes).toHaveLength(2);
  expect(draft.keyframes[0].positions['sample-a3']).toEqual({x:43,y:30});
  expect(draft.keyframes[1].positions['sample-a3'].x).toBeCloseTo(58,3);

  await page.getByRole('button',{name:'Share play',exact:true}).click();
  const publicationResponse=page.waitForResponse(response=>response.request().method()==='POST'&&/\/publish$/.test(response.url()));
  await page.getByRole('button',{name:'Publish a revision',exact:true}).click();
  const result=await publicationResponse;expect(result.status()).toBe(201);
  const publication=await result.json();
  const link=page.getByLabel('Published play link');await expect(link).toBeVisible();
  const shareUrl=await link.inputValue();
  expect(publication.scene.source).toBeUndefined();
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await page.locator('[data-actor="sample-a3"]').click();
  await page.getByLabel('Player name').fill('Private draft changed');
  const laterSave=page.waitForResponse(response=>response.request().method()==='PUT'&&/\/api\/drafts\/[^/?]+$/.test(response.url()));
  await page.getByRole('button',{name:'Save',exact:true}).click();expect((await laterSave).status()).toBe(200);
  const immutable=await request.get(`/api/publications/${publication.id}`);expect(immutable.status()).toBe(200);
  expect((await immutable.json()).scene.actors.find((actor:{id:string})=>actor.id==='sample-a3').name).toBe('Alex playmaker');

  const readerContext=await browser.newContext({viewport:{width:1365,height:950}}),reader=await readerContext.newPage();
  await reader.goto(shareUrl);
  await expect(reader.getByRole('heading',{name:'E2E authored passing lane'})).toBeVisible();
  await expect(reader.getByRole('button',{name:'Save',exact:true})).toHaveCount(0);
  await expect(reader.getByRole('button',{name:'Arrow tool'})).toHaveCount(0);
  await reader.getByRole('button',{name:'Attach a pitch point'}).click();
  await tapPitch(reader,70,24);
  await expect(reader.getByRole('button',{name:'Pitch point attached'})).toBeVisible();
  await reader.getByLabel('Your comment').fill('The passing lane opens here.');
  const commentResponse=reader.waitForResponse(response=>response.request().method()==='POST'&&/\/comments$/.test(response.url()));
  await reader.getByRole('button',{name:'Post comment'}).click();await devLogin(reader,'reader');
  const comment=await commentResponse;expect(comment.status()).toBe(201);const body=await comment.json();
  expect(body.publicationId).toBe(publication.id);expect(body.anchor.point.x).toBeCloseTo(70,3);expect(body.anchor.point.y).toBeCloseTo(24,3);
  await expect(reader.getByText('The passing lane opens here.',{exact:true})).toBeVisible();
  await reader.reload();await expect(reader.getByText('The passing lane opens here.',{exact:true})).toBeVisible();
  await readerContext.close();
});

test('keyboard selection and configurable pitch stay in the same metre coordinates',async({page})=>{
  await openSample(page);
  const player=page.locator('[data-actor="sample-a3"]');await player.focus();await player.press('Enter');
  await expect(page.getByLabel('Pitch X (m)')).toHaveValue('43');await player.press('ArrowRight');await expect(page.getByLabel('Pitch X (m)')).toHaveValue('44');
  await page.getByRole('button',{name:'Deselect player'}).click();
  await page.locator('.pitch-settings summary').click();await page.getByLabel('Length (m)').fill('110');await page.getByLabel('Width (m)').fill('80');
  await expect(page.locator('.board-canvas')).toHaveAttribute('viewBox','-5 -5 120 90');
  await expect(page.locator('.pitch-surface')).toHaveAttribute('width','110');await expect(page.locator('.pitch-surface')).toHaveAttribute('height','80');
});

test('uploaded screenshot completes crop, guided alignment, manual player review and 3D exploration',async({page})=>{
  test.setTimeout(150_000);
  await page.goto('/');
  await page.getByLabel('Upload match screenshot').setInputFiles({name:'generated-empty-pitch.png',mimeType:'image/png',buffer:emptyPitchPng()});
  await expect(page.getByRole('heading',{name:'Keep the play. Crop the rest.'})).toBeVisible();
  await page.getByRole('button',{name:'Full image',exact:true}).click();
  await page.getByRole('button',{name:'Create tactical board'}).click();
  await expect(page.getByRole('heading',{name:'Does the pitch line up?'})).toBeVisible({timeout:120_000});
  await expect(page.getByLabel('Visible landmarks')).toHaveValue('0');
  async function sourceTap(x:number,y:number){
    const svg=page.locator('.source-canvas');await svg.scrollIntoViewIfNeeded();
    const position=await svg.evaluate((element,point)=>{const matrix=(element as SVGSVGElement).getScreenCTM();if(!matrix)throw new Error('Source image is not rendered.');const screen=new DOMPoint(point.x,point.y).matrixTransform(matrix);return{x:screen.x,y:screen.y};},{x,y});
    await page.mouse.click(position.x,position.y);
  }
  // Known penalty-area corners, ordered to match the reference diagram.
  for(const [x,y] of [[.05,138.4],[165,138.4],[165,541.6],[.05,541.6]])await sourceTap(x,y);
  await page.getByRole('button',{name:'Apply alignment'}).click();
  await expect.poll(()=>page.locator('.source-canvas polyline').count()).toBeGreaterThanOrEqual(4);
  await page.getByRole('button',{name:'Looks right'}).click();
  await expect(page.getByRole('heading',{name:'A quick check before you explore.'})).toBeVisible();
  await expect(page.locator('.source-marker')).toHaveCount(0);
  await expect(page.getByText('0 visible players · 0 to review')).toBeVisible();
  await page.getByRole('button',{name:'Add player',exact:true}).click();
  await sourceTap(300,300);
  await expect(page.locator('.source-marker')).toHaveCount(1);
  await expect(page.getByLabel('Player name')).toBeVisible();
  await page.getByLabel('Player name').fill('Manually placed from source');
  expect(Number(await page.getByLabel('Pitch X (m)').inputValue())).toBeCloseTo(30,1);
  expect(Number(await page.getByLabel('Pitch Y (m)').inputValue())).toBeCloseTo(30,1);
  await page.getByRole('button',{name:'Open the editor'}).click();
  await expect(page.getByRole('group',{name:'Interactive tactical pitch'})).toBeVisible();
  await expect(page.locator('[data-actor]')).toHaveCount(1);
  await expect(page.locator('[data-actor]')).toHaveAttribute('aria-label','Manually placed from source');
  const saveResponse=page.waitForResponse(response=>response.request().method()==='PUT'&&/\/api\/drafts\/[^/?]+$/.test(response.url()));
  await page.getByRole('button',{name:'Save',exact:true}).click();await devLogin(page,'uploaded-source');
  const saved=await saveResponse;expect(saved.status()).toBe(200);
  const draft=await saved.json();expect(draft.source.assetId).toBeTruthy();expect(draft.source.url).not.toMatch(/^data:/);expect(draft.source.url.length).toBeLessThan(4000);expect(draft.calibration.status).toBe('confirmed');
  expect(draft.actors).toHaveLength(1);expect(draft.actors[0].provenance).toBe('manual');
  await page.getByRole('tab',{name:'3D / VR'}).click();
  await expect(page.locator('.scene-3d')).toBeVisible();
  await expect(page.getByRole('toolbar',{name:'3D interaction tools'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Player view',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Player view',exact:true}).click();
  await expect(page.getByText('An approximate viewpoint at this player’s position. Facing direction is not inferred from the screenshot.')).toBeVisible();
});
