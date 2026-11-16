import assert from 'node:assert/strict';

/** Magnetic dock: no reflow during aim, whole-group hit testing and native transfer. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  const owner = (fn, data) => capture.component('ex-machine-workspace', fn, data);
  const finish = async () => {
    await capture.settle();
    await capture.waitFor(() => document.querySelector('ex-task-list').getAnimations({subtree:true}).every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
  };
  const start = async id => {
    const items = await capture.evaluate(id => {
      const transfer = new window.DataTransfer();
      document.querySelector(`[data-task-id="11"] [data-session-id="${id}"] .select`).dispatchEvent(new window.DragEvent('dragstart', {bubbles:true,cancelable:true,dataTransfer:transfer}));
      return [...transfer.types].map(mimeType => ({mimeType,data:transfer.getData(mimeType)}));
    }, id);
    return {items,dragOperationsMask:17};
  };
  const at = selector => capture.evaluate(selector => { const r = document.querySelector(selector).getBoundingClientRect(); return {x:r.x+r.width*.5,y:r.y+r.height*.5}; }, selector);
  const over = async (selector, data) => { const point = await at(selector); await capture.cdp('Input.dispatchDragEvent',{type:'dragEnter',...point,data}); await capture.cdp('Input.dispatchDragEvent',{type:'dragOver',...point,data}); await capture.settle(); return point; };
  const cancel = async () => { await capture.evaluate(() => document.dispatchEvent(new window.DragEvent('dragend',{bubbles:true}))); await capture.settle(); assert.equal(await capture.evaluate(()=>!!document.querySelector('ex-session-drag-preview')),false); };
  const geometry = () => capture.evaluate(() => [...document.querySelectorAll('[data-task-id="11"] [data-session-id]')].map(row => ({id:row.dataset.sessionId,y:row.getBoundingClientRect().y,height:row.getBoundingClientRect().height})));
  for (const theme of ['light','dark']) {
    await capture.theme(theme); await capture.viewport(1440,960);
    await capture.component('ex-connected-workspace-demo', component=>component.fixture.nestingScene());
    await owner(async component => { await component.store.refresh(); await component.store.loadSessionChildren({taskId:'11',sessionId:'101'}); component.store.selectSession({taskId:'11',sessionId:'107'}); });
    await capture.waitFor(()=>document.querySelector('.children [data-session-id="108"]'));
    await finish();
    const before = await geometry();
    const data = await start('106');
    // Children are part of their root's destination. No spring-opening/reflow.
    await over('[data-session-id="108"] .select',data);
    assert.equal(await capture.evaluate(()=>document.querySelector('.drop-active')?.dataset.sessionRoot),'101');
    assert.deepEqual(await geometry(),before);
    for (const [name,time] of [['ghost',0],['revealed-row',1100]]) {
      await capture.evaluate(time=>document.getAnimations().filter(animation=>animation.animationName?.includes('session-ghost-')).forEach(animation=>{animation.pause();animation.currentTime=time;}),time);
      yield {name:`${theme}-${name}`,inspect:['.drop-active','ex-session-drag-preview']};
    }
    // The overlay is pointer-transparent: the covered root can be targeted.
    await over('[data-session-id="102"] .select',data);
    assert.equal(await capture.evaluate(()=>document.querySelector('.drop-active')?.dataset.sessionRoot),'102');
    assert.deepEqual(await geometry(),before);
    yield {name:`${theme}-covered-target`,inspect:['.drop-active','ex-session-drag-preview']};
    const point = await over('[data-session-id="108"] .select',data);
    await capture.cdp('Input.dispatchDragEvent',{type:'drop',...point,data});
    await capture.waitFor(()=>document.querySelector('.children [data-session-id="106"]'));
    await finish();
    assert.deepEqual(await capture.evaluate(()=>[...document.querySelectorAll('[data-session-root="101"] .children [data-session-id]')].map(row=>row.dataset.sessionId)),['107','108','106']);
    yield {name:`${theme}-appended-older-session`,inspect:['.children']};
    const out = await start('106');
    const outPoint = await over('[data-task-id="11"] header',out);
    assert.equal(await capture.evaluate(()=>!!document.querySelector('.session-drop-root')),true);
    yield {name:`${theme}-drag-out`,inspect:['.session-drop-root']};
    await capture.cdp('Input.dispatchDragEvent',{type:'drop',...outPoint,data:out});
    await capture.waitFor(()=>document.querySelector('[data-session-root="106"]'));
    await finish();
    // Keep native MIME data and copy semantics into the real composer.
    const mention = await start('106');
    const mentionPoint = await over('ex-composer textarea',mention);
    await capture.cdp('Input.dispatchDragEvent',{type:'drop',...mentionPoint,data:mention});
    await capture.waitFor(()=>document.querySelector('ex-composer ex-mention')?.textContent?.includes('Fix tooltip overlap'));
    await cancel();
    assert.equal(await capture.evaluate(()=>!!document.querySelector('[data-session-root="106"]')),true);
    yield {name:`${theme}-composer-mention`,inspect:['ex-composer']};
    // Narrow/reduced motion is steady, including a change during an active drag.
    await capture.viewport(940,640); await capture.reducedMotion(true);
    const reduced = await start('106');
    await over('[data-session-id="101"] .select',reduced);
    assert.equal(await capture.evaluate(()=>document.querySelector('ex-session-drag-preview').getAnimations({subtree:true}).length),0);
    yield {name:`${theme}-reduced-dock`,inspect:['.drop-active','ex-session-drag-preview']};
    await capture.press('Escape'); await cancel();
    await capture.reducedMotion(false);
  }
}
