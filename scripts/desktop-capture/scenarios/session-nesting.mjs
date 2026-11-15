import assert from 'node:assert/strict';

/** Real outline/bridge adapter; native drops and CDK keyboard moves in both themes. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  const owner = (fn, data) => capture.component('ex-machine-workspace', fn, data);
  const finish = async () => {
    await capture.settle();
    await capture.waitFor(() => document.querySelector('ex-task-list').getAnimations({subtree:true}).every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
  };
  for (const theme of ['light','dark']) {
    await capture.theme(theme); await capture.viewport(1440,960);
    await owner(component => component.store.selectSession({taskId:'11',sessionId:'102'}));
    await finish();
    const items = await capture.evaluate(() => {
      const transfer = new window.DataTransfer();
      document.querySelector('[data-task-id="11"] [data-session-id="102"] .select').dispatchEvent(new window.DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:transfer}));
      return [...transfer.types].map(mimeType=>({mimeType,data:transfer.getData(mimeType)}));
    });
    const target = await capture.evaluate(() => { const rect = document.querySelector('[data-task-id="11"] [data-session-id="101"]').getBoundingClientRect(); return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}; });
    const data = {items,dragOperationsMask:17};
    await capture.cdp('Input.dispatchDragEvent',{type:'dragEnter',...target,data});
    await capture.cdp('Input.dispatchDragEvent',{type:'dragOver',...target,data});
    await capture.waitFor(()=>document.querySelector('.drop-active'));
    yield {name:`${theme}-drop-target`,inspect:['ex-workspace-navigation','.drop-active','.drop-hint']};
    await capture.cdp('Input.dispatchDragEvent',{type:'drop',...target,data});
    await capture.waitFor(()=>document.querySelector('.children [data-session-id="102"]'));
    await finish();
    assert.equal(await capture.evaluate(()=>!!document.querySelector('.children [data-session-id="102"]').closest('[inert]')),false);
    await capture.hover('ex-workspace-navigation h1');
    yield {name:`${theme}-nested`,inspect:['ex-workspace-navigation','.children']};
    await capture.click('button[aria-label="Collapse children of Guard concurrent requests"]');
    await finish();
    assert.equal(await capture.evaluate(()=>!!document.querySelector('.children [data-session-id="102"]').closest('[inert]')),true);
    await capture.click('button[aria-label="Expand children of Guard concurrent requests"]'); await finish();
    await capture.click('.children button[aria-label="Move Review the race condition"]');
    await capture.press('Home');
    await capture.waitFor(()=>document.activeElement?.textContent?.includes('Move to task level'));
    yield {name:`${theme}-keyboard-move`,inspect:['ex-dropdown-menu']};
    await capture.press('Enter');
    await capture.waitFor(()=>!document.querySelector('.children [data-session-id="102"]'));
    await finish();
    assert.equal(await owner(component=>component.store.selectedSessionId()),'102');
    yield {name:`${theme}-task-level`,inspect:['ex-workspace-navigation']};
    await capture.viewport(940,640); await capture.reducedMotion(true);
    await owner(component=>component.store.moveSession({taskId:'11',sessionId:'102',parentSessionId:'101'}));
    await capture.waitFor(()=>document.querySelector('.children [data-session-id="102"]'));
    yield {name:`${theme}-narrow-reduced`,inspect:['ex-workspace-navigation','.children']};
    await owner(component=>component.store.moveSession({taskId:'11',sessionId:'102',parentSessionId:null}));
    await capture.reducedMotion(false);
  }
  await capture.viewport(1440,960);
  await capture.component('ex-connected-workspace-demo',component=>{ component.fixture.manyChildren(); component.fixture.setChildReads('held'); });
  await owner(component=>component.store.refresh());
  if (await capture.evaluate(()=>!!document.querySelector('button[aria-label="Collapse children of Guard concurrent requests"]'))) await capture.click('button[aria-label="Collapse children of Guard concurrent requests"]');
  await capture.click('button[aria-label="Expand children of Guard concurrent requests"]');
  await capture.waitFor(()=>document.querySelector('.children [role="status"]'));
  yield {name:'children-loading',inspect:['.children']};
  await capture.component('ex-connected-workspace-demo',component=>component.fixture.setChildReads('failed'));
  await capture.waitFor(()=>document.querySelector('.children [role="alert"]'));
  yield {name:'children-failed',inspect:['.children']};
  await capture.component('ex-connected-workspace-demo',component=>component.fixture.setChildReads('ready'));
  await capture.click('.children [role="alert"] button');
  await capture.waitFor(()=>document.querySelectorAll('.children [data-session-id]').length===20);
  await finish();
  assert.equal(await capture.evaluate(()=>document.querySelectorAll('.children [data-session-id]').length),20);
  await capture.evaluate(()=>document.querySelector('.children button.earlier').scrollIntoView({block:'center'}));
  await capture.settle();
  await capture.click('.children button.earlier');
  await capture.waitFor(()=>[...document.querySelectorAll('.children button')].some(button=>button.textContent==='Latest child sessions'));
  yield {name:'children-earlier-page',inspect:['.children']};
  await capture.evaluate(()=>{ const button=[...document.querySelectorAll('.children button')].find(button=>button.textContent==='Latest child sessions'); button.focus(); });
  await capture.press('Enter');
  await capture.waitFor(()=>document.querySelector('.children [data-session-id="444"]'));
  await owner(component=>component.store.archiveSession({taskId:'11',session:{id:'101',status:'running'}}));
  await finish();
  assert.equal(await capture.evaluate(()=>!!document.querySelector('[data-session-id="444"]')),true);
  assert.equal(await capture.evaluate(()=>!!document.querySelector('.children [data-session-id="444"]')),false);
  yield {name:'parent-archived-children-retained',inspect:['ex-workspace-navigation']};

}
