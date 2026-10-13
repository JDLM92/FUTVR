import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

export async function openSample(page: Page) {
  await page.goto('/');
  await page.getByRole('button',{name:/Try a sample play/}).click();
  await expect(page.getByRole('group',{name:'Interactive tactical pitch'})).toBeVisible();
}

export async function pitchPoint(page: Page, x: number, y: number) {
  return page.locator('.board-canvas').evaluate((element,point)=>{
    const svg=element as SVGSVGElement,screen=svg.getScreenCTM();
    if(!screen)throw new Error('Pitch is not rendered.');
    const position=new DOMPoint(point.x,point.y).matrixTransform(screen);
    return{x:position.x,y:position.y};
  },{x,y});
}

export async function tapPitch(page: Page, x: number, y: number, touch = false) {
  const point=await pitchPoint(page,x,y);
  if(touch)await page.touchscreen.tap(point.x,point.y);else await page.mouse.click(point.x,point.y);
}

export async function devLogin(page: Page, suffix = 'owner') {
  const dialog=page.getByRole('dialog',{name:'Your plays, wherever you are.'});
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Email address').fill(`e2e-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2,7)}@example.com`);
  await dialog.getByRole('button',{name:'Send a code'}).click();
  await expect(dialog.getByText('Local development · no email was sent.')).toBeVisible();
  const code=await dialog.locator('.dev-notice strong').textContent();
  expect(code).toMatch(/^\d{6}$/);
  await dialog.getByLabel('Verification code').fill(code!);
  await dialog.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(dialog).not.toBeVisible();
}

export async function assertNoOverflow(page: Page) {
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
}
