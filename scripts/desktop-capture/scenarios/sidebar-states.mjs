import assert from 'node:assert/strict';

/** Connected sidebar behavior; fixture data stays in the isolated preview entry. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  const owner = (fn, data) => capture.component('ex-machine-workspace', fn, data);
  const finish = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
    await capture.settle();
  };
  const state = async mode => {
    await capture.component('ex-connected-workspace-demo', (component, value) => component.fixture.sidebarState(value), mode);
    await owner(component => component.store.selectProject('1'));
    await capture.waitFor(() => !document.querySelector('ex-workspace-navigation [aria-busy="true"]'));
    await finish();
  };
  const inspect = ['ex-workspace-navigation', 'ex-workspace-navigation header', 'ex-workspace-navigation ex-task-list', 'ex-workspace-navigation footer'];
  const checkHorizontalScroll = async () => {
    const point = await capture.evaluate(() => {
      const list = document.querySelector('ex-workspace-navigation ex-task-list');
      const box = list.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    });
    await capture.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 120, deltaY: 0 });
    await capture.settle();
    assert.equal(await capture.evaluate(() => document.querySelector('ex-workspace-navigation ex-task-list').scrollLeft), 0, 'Sidebar must not scroll horizontally');
  };
  for (const theme of ['light', 'dark']) {
    await capture.viewport(1440, 900); await capture.theme(theme);
    await state('single');
    await checkHorizontalScroll();
    assert.equal(await capture.evaluate(() => document.querySelectorAll('ex-workspace-navigation ex-repo-tag').length), 0);
    const attention = '[data-task-id="11"] ex-session-row button.attention';
    const idleColor = await capture.evaluate(selector => getComputedStyle(document.querySelector(selector)).backgroundColor, attention);
    await capture.hover(attention); await finish();
    await capture.waitFor(() => document.querySelector('ex-tooltip'));
    assert.notEqual(await capture.evaluate(selector => getComputedStyle(document.querySelector(selector)).backgroundColor, attention), idleColor);
    yield { name: `${theme}-single-attention-hover`, inspect };
    await capture.hover('[data-task-id="12"] ex-session-row button.failed'); await finish();
    yield { name: `${theme}-failed-hover`, inspect };
    await capture.click(attention); await finish();
    assert.equal(await capture.evaluate(() => document.querySelectorAll('ex-workspace-task-header ex-repo-tag').length), 0);
    const taskHeader = '[data-task-id="11"] header';
    const idleHeader = await capture.evaluate(selector => {
      const header = document.querySelector(selector);
      const box = header.getBoundingClientRect();
      return { color: getComputedStyle(header).backgroundColor, left: box.left, width: box.width };
    }, taskHeader);
    await capture.hover(`${taskHeader} .toggle`); await finish();
    await capture.waitFor(() => document.querySelector('[data-task-id="11"] header .add') && getComputedStyle(document.querySelector('[data-task-id="11"] header .add')).opacity === '1');
    const hoveredHeader = await capture.evaluate(selector => {
      const header = document.querySelector(selector);
      const box = header.getBoundingClientRect();
      const action = header.querySelector('.add').getBoundingClientRect();
      return {
        color: getComputedStyle(header).backgroundColor, left: box.left, width: box.width,
        titleColor: getComputedStyle(header.querySelector('.toggle')).backgroundColor,
        coversAction: box.right >= action.right,
        fullWidth: box.width === header.closest('article').getBoundingClientRect().width,
      };
    }, taskHeader);
    assert.notEqual(hoveredHeader.color, idleHeader.color);
    assert.equal(hoveredHeader.titleColor, 'rgba(0, 0, 0, 0)');
    assert.equal(hoveredHeader.left, idleHeader.left);
    assert.equal(hoveredHeader.width, idleHeader.width);
    assert.equal(hoveredHeader.coversAction, true);
    assert.equal(hoveredHeader.fullWidth, true);
    yield { name: `${theme}-task-hover`, inspect: [...inspect, taskHeader, `${taskHeader} .toggle`], metadata: hoveredHeader };
    await capture.hover(`${taskHeader} ex-task-signal`); await finish();
    assert.equal(await capture.evaluate(selector => getComputedStyle(document.querySelector(selector)).backgroundColor, taskHeader), hoveredHeader.color);
    yield { name: `${theme}-task-status-hover`, inspect: [...inspect, taskHeader] };
    await capture.hover(`${taskHeader} .add button`); await finish();
    assert.equal(await capture.evaluate(selector => getComputedStyle(document.querySelector(selector)).backgroundColor, taskHeader), hoveredHeader.color);
    assert.notEqual(await capture.evaluate(selector => getComputedStyle(document.querySelector(`${selector} .add button`)).backgroundColor, taskHeader), hoveredHeader.color);
    yield { name: `${theme}-task-add-hover`, inspect: [...inspect, taskHeader, `${taskHeader} .add button`] };
    await capture.click(`${taskHeader} .toggle`);
    await capture.press('Enter'); await finish();
    await capture.hover('ex-workspace-navigation h1');
    await capture.press('Tab'); await finish();
    assert.equal(await capture.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'New session in this task');
    assert.equal(await capture.evaluate(selector => getComputedStyle(document.querySelector(selector)).backgroundColor, taskHeader), hoveredHeader.color);
    assert.notEqual(await capture.evaluate(() => getComputedStyle(document.activeElement).boxShadow), 'none');
    yield { name: `${theme}-task-keyboard-focus`, inspect: [...inspect, taskHeader, `${taskHeader} .add button`] };
    await capture.click('ex-workspace-navigation .project-title');
    await capture.press('Escape'); await finish();
    assert.equal(await capture.evaluate(() => document.activeElement?.classList.contains('project-title')), true);
    await capture.press('Tab');
    assert.equal(await capture.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Focus project, mute other projects');
    await capture.press('Tab');
    assert.equal(await capture.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'New task');
    yield { name: `${theme}-keyboard-focus`, inspect };

    await state('multiple');
    assert.equal(await capture.evaluate(() => document.querySelectorAll('ex-workspace-navigation ex-repo-tag').length), 2);
    await owner(component => component.store.selectSession({ taskId: '11', sessionId: '101' }));
    await finish();
    assert.equal(await capture.evaluate(() => document.querySelector('ex-workspace-task-header ex-repo-tag')?.textContent.trim()), 'payments-api');
    yield { name: `${theme}-multiple-repositories`, inspect };
    await owner(component => component.store.selectProject('all')); await finish();
    assert.equal(await capture.evaluate(() => document.querySelectorAll('ex-workspace-navigation ex-repo-tag').length), 2);
    yield { name: `${theme}-all-projects`, inspect };
    await capture.component('ex-connected-workspace-demo', component => component.fixture.workspaceUpdateProject('preview', { projectId: 1, name: 'Payments and settlements across international merchant processing services' }));
    await owner(async component => { await component.store.refresh(); await component.store.selectProject('1'); });
    await capture.hover('ex-workspace-navigation .project-title');
    await capture.waitFor(() => document.querySelector('ex-tooltip')?.textContent.includes('international merchant'));
    await finish();
    assert.equal(await capture.evaluate(() => { const box = document.querySelector('ex-tooltip').getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; }), true);
    yield { name: `${theme}-long-project-hover`, inspect: [...inspect, 'ex-tooltip'] };
    await capture.component('ex-connected-workspace-demo', component => component.fixture.workspaceUpdateProject('preview', { projectId: 1, name: 'Payments' }));
    await owner(component => component.store.refresh());

    await state('empty');
    await capture.waitFor(() => document.querySelector('ex-task-list .empty')?.closest('[inert]') === null);
    yield { name: `${theme}-empty`, inspect };
    await capture.click('ex-status-summary button:nth-child(1)'); await finish();
    assert.equal(await capture.evaluate(() => document.querySelector('ex-task-list .empty').textContent.trim()), 'No sessions match this filter.');
    yield { name: `${theme}-empty-filter`, inspect };
    await owner(component => component.store.showClosed(true)); await finish();
    assert.equal(await capture.evaluate(() => !!document.querySelector('ex-workspace-navigation ex-status-summary')), false);
    yield { name: `${theme}-closed-empty`, inspect };

    await state('many');
    await capture.viewport(1000, 700); await capture.reducedMotion(true); await finish();
    const geometry = await capture.evaluate(() => {
      const list = document.querySelector('ex-workspace-navigation ex-task-list');
      const header = document.querySelector('ex-workspace-navigation header');
      const footer = document.querySelector('ex-workspace-navigation footer');
      return { scrollable: list.scrollHeight > list.clientHeight, headerTop: header.getBoundingClientRect().top, footerBottom: footer.getBoundingClientRect().bottom, windowHeight: innerHeight };
    });
    assert.equal(geometry.scrollable, true);
    assert.ok(geometry.footerBottom <= geometry.windowHeight);
    await checkHorizontalScroll();
    await capture.evaluate(() => { const list = document.querySelector('ex-workspace-navigation ex-task-list'); list.scrollTop = list.scrollHeight; });
    await finish();
    assert.equal(await capture.evaluate(() => document.querySelector('ex-workspace-navigation header').getBoundingClientRect().top), geometry.headerTop);
    assert.equal(await capture.evaluate(() => { const row = document.querySelector('[data-task-id="30"]'); const list = document.querySelector('ex-workspace-navigation ex-task-list'); return row.getBoundingClientRect().bottom <= list.getBoundingClientRect().bottom; }), true);
    yield { name: `${theme}-many-scrolled-narrow-reduced`, inspect, metadata: geometry };
    await capture.hover('[data-task-id="30"] header .toggle'); await finish();
    assert.equal(await capture.evaluate(() => getComputedStyle(document.querySelector('[data-task-id="30"] header')).backgroundColor), hoveredHeader.color);
    yield { name: `${theme}-task-hover-narrow-reduced`, inspect: [...inspect, '[data-task-id="30"] header'] };
    await owner(component => component.store.busy.set(true)); await finish();
    assert.equal(await capture.evaluate(() => document.querySelectorAll('ex-workspace-navigation header button:disabled').length), 2);
    assert.equal(await capture.evaluate(() => document.querySelectorAll('ex-workspace-navigation .add').length), 0);
    yield { name: `${theme}-busy`, inspect };
    await owner(component => component.store.busy.set(false));
    await capture.reducedMotion(false);
  }
}
