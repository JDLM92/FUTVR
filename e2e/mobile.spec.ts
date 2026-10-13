import { expect, test } from '@playwright/test';
import { assertNoOverflow, devLogin, openSample, tapPitch } from './helpers';

test('touch authoring, safe drawing cancel and local draft recovery on a phone viewport',async({page})=>{
  await openSample(page);await assertNoOverflow(page);
  await page.getByRole('button',{name:'Arrow tool'}).tap();await tapPitch(page,40,28,true);
  await expect(page.getByRole('button',{name:'Cancel',exact:true})).toBeVisible();await page.getByRole('button',{name:'Cancel',exact:true}).tap();
  await expect(page.locator('[data-annotation]')).toHaveCount(0);
  await tapPitch(page,40,28,true);await tapPitch(page,74,20,true);await expect(page.locator('[data-annotation]')).toHaveCount(1);
  await page.getByRole('button',{name:'More drawing tools'}).tap();await page.getByRole('button',{name:'Add player',exact:true}).tap();
  await tapPitch(page,18,54,true);await expect(page.locator('[data-actor]')).toHaveCount(17);
  await expect(page.getByLabel('Player name')).toBeVisible();await page.getByLabel('Player name').fill('Mobile added player');
  await page.getByLabel('Play title').fill('Mobile local draft');
  await expect.poll(async()=>page.evaluate(async()=>{
    return await new Promise<string|null>((resolve,reject)=>{const open=indexedDB.open('futvr-drafts',1);open.onerror=()=>reject(open.error);open.onsuccess=()=>{const read=open.result.transaction('drafts').objectStore('drafts').get('current');read.onsuccess=()=>{resolve(read.result?.title??null);open.result.close();};read.onerror=()=>reject(read.error);};});
  })).toBe('Mobile local draft');
  await page.reload();await page.getByRole('button',{name:'Resume your local draft: Mobile local draft'}).tap();
  await expect(page.getByLabel('Play title')).toHaveValue('Mobile local draft');await expect(page.locator('[data-actor]')).toHaveCount(17);await expect(page.locator('[data-annotation]')).toHaveCount(1);await assertNoOverflow(page);
  const saveResponse=page.waitForResponse(response=>response.request().method()==='PUT'&&/\/api\/drafts\/[^/?]+$/.test(response.url()));
  await page.getByRole('button',{name:'Save',exact:true}).tap();await devLogin(page,'mobile-recovered');
  const saved=await saveResponse;expect(saved.status()).toBe(200);expect((await saved.json()).title).toBe('Mobile local draft');
  await page.getByRole('tab',{name:'3D / VR'}).tap();
  await expect(page.locator('.scene-3d')).toBeVisible();await expect(page.getByRole('toolbar',{name:'3D interaction tools'})).toBeVisible();
  await assertNoOverflow(page);
});
