import assert from 'node:assert/strict';

/** Magnetic dock: the group extends into a slot, the chip snaps in and breathes,
 * no row reflows while aiming, the ghost holds until the confirmed row lands,
 * and native transfer still reaches the composer. */
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
  // Wait for the snap/reach transitions; the infinite breath keeps running.
  const snapped = () => capture.waitFor(() => [...(document.querySelector('ex-session-drag-preview')?.getAnimations({subtree:true}) ?? [])].every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
  const over = async (selector, data) => { const point = await at(selector); await capture.cdp('Input.dispatchDragEvent',{type:'dragEnter',...point,data}); await capture.cdp('Input.dispatchDragEvent',{type:'dragOver',...point,data}); await capture.settle(); await snapped(); return point; };
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
    assert.equal(await capture.evaluate(()=>!!document.querySelector('.drop-active.docked') && !!document.querySelector('ex-session-drag-preview .extension') && !!document.querySelector('ex-session-drag-preview .chip.docked')),true);
    assert.equal(await capture.evaluate(()=>document.querySelector('.drop-active .child-count.pending')?.textContent.trim()),'3');
    for (const [name,time] of [['ghost',0],['revealed-row',1100]]) {
      await capture.evaluate(time=>document.getAnimations().filter(animation=>animation.animationName?.includes('session-dock-breathe')).forEach(animation=>{animation.pause();animation.currentTime=time;}),time);
      yield {name:`${theme}-${name}`,inspect:['.drop-active','ex-session-drag-preview .extension','ex-session-drag-preview .chip']};
    }
    // The overlay is pointer-transparent: the covered root can be targeted.
    await over('[data-session-id="102"] .select',data);
    assert.equal(await capture.evaluate(()=>document.querySelector('.drop-active')?.dataset.sessionRoot),'102');
    assert.deepEqual(await geometry(),before);
    yield {name:`${theme}-covered-target`,inspect:['.drop-active','ex-session-drag-preview']};
    const point = await over('[data-session-id="108"] .select',data);
    await capture.component('ex-connected-workspace-demo', component => component.fixture.holdSessionMoves(true));
    await capture.cdp('Input.dispatchDragEvent',{type:'drop',...point,data});
    // No dragend or backend receipt: the original row releases on the first paint.
    await capture.settle();
    assert.deepEqual(await capture.evaluate(() => {
      const source = document.querySelector('[data-session-root="106"] .branch-row');
      const button = source.querySelector('.select');
      return { opacity: getComputedStyle(source).opacity, buttonOpacity: getComputedStyle(button).opacity,
        labelOpacity: getComputedStyle(button.querySelector('.label')).opacity, cursor: getComputedStyle(button).cursor,
        dragging: !!document.querySelector('.dragging, .drag-source, .unavailable, .outdent-preview') };
    }), {opacity:'1',buttonOpacity:'1',labelOpacity:'1',cursor:'pointer',dragging:false});
    yield {name:`${theme}-released-before-confirmation`,inspect:['[data-session-root="106"]','.children']};
    await capture.component('ex-connected-workspace-demo', component => component.fixture.holdSessionMoves(false));
    await capture.waitFor(()=>document.querySelector('.children [data-session-id="106"]'));
    // The landing ghost is released once the confirmed row is in place.
    await capture.waitFor(()=>!document.querySelector('ex-session-drag-preview'));
    await finish();
    assert.deepEqual(await capture.evaluate(()=>[...document.querySelectorAll('[data-session-root="101"] .children [data-session-id]')].map(row=>row.dataset.sessionId)),['107','108','106']);
    yield {name:`${theme}-appended-older-session`,inspect:['.children']};
    const out = await start('106');
    // A child's own group cannot take it back; the header offers task level.
    assert.equal(await capture.evaluate(()=>document.querySelector('[data-session-root="101"]').classList.contains('unavailable') && !!document.querySelector('header.session-drop-ready')),true);
    yield {name:`${theme}-drag-child`,inspect:['.unavailable','header.session-drop-ready']};
    const outPoint = await over('[data-task-id="11"] header',out);
    assert.equal(await capture.evaluate(()=>!!document.querySelector('.session-drop-root') && !!document.querySelector('.outdent-preview')),true);
    yield {name:`${theme}-drag-out`,inspect:['.session-drop-root','.outdent-preview','ex-session-drag-preview .chip']};
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
    const reducedPoint = await at('[data-session-id="101"] .select');
    await capture.component('ex-connected-workspace-demo', component => component.fixture.holdSessionMoves(true));
    await capture.cdp('Input.dispatchDragEvent',{type:'drop',...reducedPoint,data:reduced});
    await capture.settle();
    assert.equal(await capture.evaluate(() => !!document.querySelector('.dragging, .drag-source, .unavailable, .outdent-preview')),false);
    yield {name:`${theme}-reduced-released`,inspect:['[data-session-root="106"]']};
    await capture.component('ex-connected-workspace-demo', component => component.fixture.holdSessionMoves(false));
    await capture.waitFor(()=>document.querySelector('.children [data-session-id="106"]'));
    await finish();
    await capture.reducedMotion(false);
  }
}
