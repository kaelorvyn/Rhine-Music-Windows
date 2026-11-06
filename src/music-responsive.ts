/** Measure fixed controls on layout changes, leaving only the reading pane flexible. */
export function mountMusicResponsiveLayout(stage: HTMLElement) {
  const header = stage.querySelector<HTMLElement>('.music-header')!;
  const article = stage.querySelector<HTMLElement>('#album-detail-content')!;
  const menu = stage.querySelector<HTMLElement>('#playlist-platform-menu')!;
  let frame = 0, disposed = false;
  const set = (name: string, value: string) => {
    if (stage.style.getPropertyValue(name) !== value) stage.style.setProperty(name, value);
  };
  const data = (name: string, value: string) => { if (stage.dataset[name] !== value) stage.dataset[name] = value; };
  const schedule = () => { if (!disposed && !frame) frame = requestAnimationFrame(() => { frame = 0; refresh(); }); };
  function positionMenu() {
    if (menu.hidden) return;
    const picker = menu.parentElement!, button = picker.querySelector('button')!;
    const viewport = window.visualViewport, left = viewport?.offsetLeft || 0;
    const width = viewport?.width || innerWidth, bottom = (viewport?.offsetTop || 0) + (viewport?.height || innerHeight);
    const anchor = button.getBoundingClientRect(), parent = picker.getBoundingClientRect();
    const x = Math.max(left + 12, Math.min(anchor.left, left + width - 12 - menu.offsetWidth));
    menu.style.left = `${x - parent.left}px`;
    menu.style.maxHeight = `${Math.max(44, bottom - anchor.bottom - 18)}px`;
  }
  function refresh() {
    if (disposed) return;
    const width = stage.clientWidth, height = stage.clientHeight;
    const portrait = stage.dataset.layout === 'portrait';
    const song = stage.dataset.mode === 'detail' && !!article.querySelector('#song-view');
    data('fittedDetail', String(song));
    const viewport = window.visualViewport;
    document.documentElement.style.setProperty('--music-visible-height', `${!viewport || viewport.scale !== 1 ? innerHeight : viewport.height}px`);
    document.documentElement.style.setProperty('--music-visible-top', `${viewport?.scale === 1 ? viewport.offsetTop : 0}px`);
    let bottom = 0, top = 0;
    const headerBottom = () => Math.ceil(header.offsetTop + header.offsetHeight);
    if (song) {
      const edge = portrait ? 20 : width <= 900 ? 16 : 52;
      const pane = article.querySelector<HTMLElement>('#song-lyric-view:not([hidden]), #song-info:not([hidden])')!;
      for (const density of ['normal', 'tight', 'minimal']) {
        data('detailDensity', density);
        bottom = headerBottom();
        // Start with the full column to measure fixed rows independently of cover size.
        set('--music-detail-top', `${bottom + 8}px`);
        const fixed = Math.ceil(article.scrollHeight - pane.clientHeight) + 4;
        const minimumTop = portrait ? bottom + 48 + Math.min(112, Math.max(48, height * .14)) + 24 : bottom + 8;
        const reading = density === 'minimal' ? 48 : portrait ? Math.max(72, Math.min(128, height * .14)) : Math.max(72, Math.min(176, height * .2));
        const maximumTop = height - edge - fixed - reading;
        if (maximumTop < minimumTop && density !== 'minimal') continue;
        const preferred = portrait ? Math.max(height * .42, bottom + 48 + Math.min(width * .66, height * .26, 280) + 24) : minimumTop;
        top = Math.max(bottom + 8, Math.min(preferred, maximumTop));
        break;
      }
    } else {
      data('detailDensity', 'normal');
      bottom = headerBottom();
      top = portrait ? Math.min(height - 140, Math.max(height * .5, bottom + 48 + Math.min(width * .6, height * .27))) : bottom + 16;
    }
    set('--music-header-bottom', `${bottom}px`);
    set('--music-detail-top', `${Math.ceil(top)}px`);
    data('headerBottom', portrait || stage.dataset.compactHeader === 'true' ? String(bottom) : '0');
    data('detailTop', String(Math.ceil(top)));
    positionMenu();
  }
  const size = new ResizeObserver(schedule);
  size.observe(header);
  size.observe(stage.querySelector('.music-navigation')!);
  const detailSize = new ResizeObserver(schedule);
  function observeDetails() {
    detailSize.disconnect();
    for (const node of article.querySelectorAll<HTMLElement>(':scope > h1, :scope > .detail-artist, .song-view-heading, .song-view-tabs, .lyric-transport, #song-view-error')) detailSize.observe(node);
    schedule();
  }
  const content = new MutationObserver(observeDetails);
  content.observe(article, { childList: true });
  const state = new MutationObserver(schedule);
  state.observe(stage, { attributes: true, attributeFilter: ['data-layout', 'data-mode', 'data-compact-header'] });
  state.observe(menu, { attributes: true, attributeFilter: ['hidden'] });
  window.visualViewport?.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('scroll', schedule);
  document.fonts.addEventListener('loadingdone', schedule);
  observeDetails();
  refresh();
  return { refresh, disconnect() {
    disposed = true; cancelAnimationFrame(frame);
    size.disconnect(); detailSize.disconnect(); content.disconnect(); state.disconnect();
    window.visualViewport?.removeEventListener('resize', schedule);
    window.visualViewport?.removeEventListener('scroll', schedule);
    document.fonts.removeEventListener('loadingdone', schedule);
  } };
}
