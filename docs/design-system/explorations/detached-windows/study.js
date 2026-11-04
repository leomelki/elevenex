const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const project = '<span class="project-mark">AC</span>';
const taskButton = () => `<button class="task-link" data-context title="View task context"><strong>Simplify checkout</strong>${icon('down')}</button>`;
const branch = `<span class="branch">${icon('branch')}leo/simplify-checkout</span>`;
const returnButton = `<button class="button return-tab" data-demo="Tab returned to the task’s Browser panel (prototype)" title="Return this tab to the task’s Browser panel">${icon('return')}<span>Return tab</span></button>`;
const chrome = `<div class="titlebar"><span class="traffic" aria-hidden="true"><i></i><i></i><i></i></span><span class="window-kind">Browser</span><span class="machine-island">${icon('laptop')}This Mac${icon('down')}</span><span class="detached-label">Detached window</span></div>`;
const browser = `<div class="browser-toolbar"><span class="navigation-decor" aria-hidden="true">${icon('back')}${icon('refresh')}</span><div class="address"><span class="server">web</span><span class="url">localhost:3000/checkout</span></div><button class="driver" data-driver aria-pressed="false" aria-label="Hand browser control to the agent">${icon('target')}<span>You’re driving</span></button><button class="icon-button" data-demo="Point and ask selected (prototype)" aria-label="Point and ask">${icon('target')}</button></div>
  <div class="sample-page"><div class="store-head"><span class="store-brand">acme<span class="brand-dot">.</span></span><span class="store-caption">Secure checkout ${icon('check')}</span></div><div class="checkout"><div class="checkout-copy"><span class="eyebrow">ALMOST YOURS</span><h3>Good things.<br>Less friction.</h3><p>A simpler checkout, from the first<br class="desktop-only"> click to the last.</p><div class="steps"><span class="completed">${icon('check')} Cart</span><span class="current">2 <span>Details</span></span><span>3 <span>Payment</span></span></div></div><div class="order-card"><div class="order-heading"><strong>Your details</strong><span>Step 2 of 3</span></div><div class="sample-field"><span>Email address</span><span>alex@example.com</span></div><div class="order-bottom"><span>2 items <b>€84.00</b></span><button class="button primary" data-demo="Payment step preview (prototype)">Continue ${icon('arrow')}</button></div></div></div></div>
  <div class="browser-footer"><span class="connection">${icon('check')}<span>Connected to task workspace</span></span><span class="driver-note">Browser control is yours</span></div>`;
const variants = [
  { id: 'a', number: '01', title: 'The context strip', tag: 'Recommended', description: 'A familiar breadcrumb with just enough context. The page gets the space; the task is always one click away.', strength: 'Best default for any detached tab',
    content: `${chrome}<div class="window-body"><div class="context-strip"><div class="identity">${project}<span class="project-name">Acme</span><span class="crumb-slash">/</span>${taskButton()}</div><span class="context-branch">${branch}</span><div class="grow"></div>${returnButton}</div><div class="browser-surface">${browser}</div></div>` },
  { id: 'b', number: '02', title: 'The task header', tag: 'More context', description: 'Bring a little more of the workspace along. Useful when you move between several tasks and branches.', strength: 'Best for frequent task switching',
    content: `${chrome}<div class="window-body"><div class="task-header"><div class="task-header-main">${project}<div><div class="task-project-label">Acme <span>/ web</span></div>${taskButton()}</div><span class="stage"><span aria-hidden="true">◧</span> In progress</span><div class="grow"></div><button class="button show-task" data-demo="Task opened in the main window (prototype)">Show task ${icon('arrow')}</button>${returnButton}</div><div class="task-header-meta">${branch}<span class="meta-divider"></span>${icon('chat')}<span>Polish the checkout flow</span><span class="grow"></span><span class="review-label">◐ 4 files to review</span></div></div><div class="browser-surface">${browser}</div></div>` },
  { id: 'c', number: '03', title: 'The companion rail', tag: 'For a second display', description: 'A quiet home for task identity beside the work. Keep session context nearby during a longer review.', strength: 'Best for a dedicated second screen',
    content: `${chrome}<div class="window-body companion"><aside class="context-rail"><div class="rail-project">${project}<strong>Acme</strong><span class="muted">/ web</span></div><span class="eyebrow">LINKED TASK</span>${taskButton()}${branch}<span class="rail-divider"></span><span class="eyebrow">SESSION</span><button class="session-link" data-demo="Session opened in the main window (prototype)">${icon('chat')}<span>Polish the<br>checkout flow</span>${icon('arrow')}</button><span class="rail-spacer"></span><button class="button rail-task" data-demo="Task opened in the main window (prototype)">Show task ${icon('arrow')}</button>${returnButton}</aside><div class="browser-surface">${browser}</div></div>` }
];
const ideas = document.querySelector('#ideas');
for (const variant of variants) {
  const article = document.createElement('article');
  article.className = `idea idea-${variant.id}`;
  article.innerHTML = `<div class="idea-description"><div class="idea-number">${variant.number}<span></span></div><h2>${variant.title}</h2><span class="idea-tag ${variant.id === 'a' ? 'recommended' : ''}">${variant.id === 'a' ? icon('check') : ''}${variant.tag}</span><p>${variant.description}</p><div class="best-for">${variant.strength}</div><button class="enlarge" data-enlarge="${variant.id}">Explore idea ${icon('expand')}</button></div><section class="mock-window variant-${variant.id}" aria-label="${variant.title} prototype">${variant.content}</section>`;
  ideas.append(article);
}

const themeButtons = document.querySelectorAll('[data-theme-choice]');
function setTheme(theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  for (const button of themeButtons) button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme));
}
let toastTimer;
document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.themeChoice) setTheme(button.dataset.themeChoice);
  if (button.hasAttribute('data-context')) document.querySelector('#detail-dialog').showModal();
  if (button.dataset.close) document.getElementById(button.dataset.close).close();
  if (button.dataset.enlarge) {
    const variant = variants.find((item) => item.id === button.dataset.enlarge);
    document.querySelector('#enlarge-title').textContent = `${variant.number} / ${variant.title}`;
    document.querySelector('#enlarge-content').innerHTML = `<section class="mock-window variant-${variant.id}">${variant.content}</section>`;
    document.querySelector('#enlarge-dialog').showModal();
  }
  if (button.hasAttribute('data-driver')) {
    const window = button.closest('.mock-window');
    const driving = button.getAttribute('aria-pressed') !== 'true';
    button.setAttribute('aria-pressed', String(driving));
    button.setAttribute('aria-label', driving ? 'Take over browser control' : 'Hand browser control to the agent');
    button.querySelector('span').textContent = driving ? 'Agent driving' : 'You’re driving';
    window.querySelector('.driver-note').textContent = driving ? 'Checking checkout · Click the pill to take over' : 'Browser control is yours';
  }
  if (button.dataset.demo) {
    const toast = document.querySelector('.toast');
    (button.closest('dialog') ?? document.body).append(toast);
    toast.textContent = button.dataset.demo;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 4000);
  }
});
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', (event) => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } });
}
