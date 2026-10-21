import './music-settings.css';

/** 设置分类：设置 tab（settings.* 的命名空间就是它的 tab 清单）。
 *
 * 上游的 tab：personalization / playback / audio / download / lyrics / cache /
 * activation / update / feedback / about / diagnostics。这里保留 Rhine 自己的
 * `local`（本地歌单设置）与 `library`（音乐与音源），按用户要求砍掉 lyrics
 * （歌词不需要）与 activation（激活密钥，不需要）；update 现在要回来了 ——
 * 用户要求「检查更新」，见 update-center.ts。
 * 顺序即导航顺序。 */
export const settingsCategories = {
  personalization: '个性化',
  playback: '播放',
  audio: '音频',
  display: '画面显示',
  download: '下载',
  cache: '缓存',
  local: '本地歌单',
  library: '音乐与音源',
 // 版本更新：检查 GitHub Release、下载便携包并自替换后重启。
  update: '版本更新',
 // 用户要求删掉 about（关于）/ feedback（反馈）/ diagnostics（诊断）；
 // developer 只剩「界面维护」（重播开场、重新载入界面），保留但不叫开发者。
  developer: '界面维护',
} as const;
export type SettingsCategory = keyof typeof settingsCategories;
export function settingsNavigation() {
 // 侧栏是一整个网格项：搜索框 + 分类导航包在一起，别让搜索框抢占网格位置。
  return `<div class="settings-sidebar"><div class="settings-search">
      <input type="search" id="settings-search" placeholder="搜索设置项…" aria-label="搜索设置项" autocomplete="off">
      <p class="settings-search-empty" id="settings-search-empty" role="status" hidden>未找到相关设置项</p>
    </div><nav class="settings-navigation" aria-label="设置分类">${Object.entries(settingsCategories).map(([key, label]) => `<button type="button" data-action="settings-category" data-category="${key}">${label}</button>`).join('')}</nav></div>`;
}
/** 搜索设置项：跨所有分类过滤。命中的分区显示，未命中的分区隐藏。
 *
 * 一个 `<section class="panel-section">` 就是一条设置项，所以按 section 过滤即可。 */
export function filterSettings(root: HTMLElement, query: string) {
  const needle = query.trim().toLowerCase();
  const pages = [...root.querySelectorAll<HTMLElement>('[data-settings-page]')];
  const empty = root.querySelector<HTMLElement>('#settings-search-empty');
  if (!needle) {
    for (const page of pages) {
      page.hidden = page.dataset.settingsPage !== root.dataset.settingsCategory;
      for (const section of page.querySelectorAll<HTMLElement>('.panel-section')) section.hidden = false;
    }
    if (empty) empty.hidden = true;
    return;
  }
  let firstHit = '';
  for (const page of pages) {
    let hits = 0;
    for (const section of page.querySelectorAll<HTMLElement>('.panel-section')) {
 // h3 是分区标题，整段文本是内容；两者任一命中就算。
      const title = section.querySelector('h3, summary')?.textContent ?? '';
      const haystack = `${title} ${section.textContent ?? ''}`.toLowerCase();
      const visible = haystack.includes(needle);
      section.hidden = !visible;
      if (visible) hits++;
    }
    page.hidden = hits === 0;
    if (hits && !firstHit) firstHit = page.dataset.settingsPage ?? '';
  }
  if (empty) empty.hidden = pages.some(page => !page.hidden);
  if (firstHit) root.dataset.settingsCategory = firstHit;
}
// Move existing controls rather than recreating them when changing categories.
// Pending metadata jobs and the original control listeners keep their DOM nodes.
export function groupSettingsContent(body: HTMLElement) {
  const controls = [...body.children] as HTMLElement[];
  for (const [key, label] of Object.entries(settingsCategories)) {
    const page = document.createElement('section');
    page.id = `settings-page-${key}`;
    page.className = 'settings-page';
    page.dataset.settingsPage = key;
    page.setAttribute('aria-labelledby', `settings-heading-${key}`);
    page.innerHTML = `<h2 id="settings-heading-${key}" tabindex="-1">${label}</h2>`;
    for (const control of controls) if (control.dataset.settingsGroup === key) page.append(control);
    body.append(page);
  }
 // 兜底：分类被删掉后，原来挂在该分类上的区块就没有归属了。它们不会被搬进
 // 任何 page，却仍留在 #panel-body 顶部 —— 结果是在**每一个**分类页顶部都
 // 显示一遍（实测踩过：删掉「关于」分类后，「版本」「开发与资源」残留成这样）。
 // 所以这里显式移除没有归属的区块，避免以后删分类再犯同样的错。
  for (const control of controls) {
    if (!control.dataset.settingsGroup) continue;
    if (!(control.dataset.settingsGroup in settingsCategories)) control.remove();
  }
 // 没有任何控件挂到这个分类上时，给一句说明，别留一个空页面。
  for (const page of body.querySelectorAll<HTMLElement>('[data-settings-page]')) {
    if (!page.querySelector('[data-settings-group]')) {
      page.insertAdjacentHTML('beforeend', `<p class="scan-status" data-settings-empty="${page.dataset.settingsPage}">这个分类下暂时没有可调的设置。</p>`);
    }
  }
}
export function selectSettingsCategory(root: HTMLElement, category: SettingsCategory) {
 // 记住当前分类：搜索清空时要回到这里，不能默认回第一页。
  root.dataset.settingsCategory = category;
  root.querySelectorAll<HTMLElement>('[data-settings-page]').forEach(page => { page.hidden = page.dataset.settingsPage !== category; });
  root.querySelectorAll<HTMLElement>('[data-action="settings-category"]').forEach(button => {
    const selected = button.dataset.category === category;
    if (selected) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  root.querySelector('#panel-body')?.scrollTo({ top: 0 });
}
