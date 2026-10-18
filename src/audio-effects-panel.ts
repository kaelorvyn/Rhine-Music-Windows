import './audio-effects-panel.css';
import { escapeHtml as esc } from './html';
import {
  applyPreset, autoPreamp, defaultEffectsConfig, effectsCategories, effectsPresets, effectsRanges,
  eqFrequencies, normalizeEffectsConfig, type EffectsConfig,
} from './audio-effects.ts';

/** 对齐上游音效面板结构：分类预设 + 十段均衡 + 前级 + 低音 + 混响 + 声场 + 动态保护。 */
const slider = (key: keyof EffectsConfig, label: string) => {
  const range = effectsRanges[key];
  if (!range) return '';
  return `
  <label class="fx-slider-row"><span>${esc(label)}</span>
    <input type="range" data-fx-range="${key}" min="${range.min}" max="${range.max}" step="${range.step}" aria-label="${esc(label)}">
    <output data-fx-value="${key}"></output><small>${esc(range.unit)}</small></label>`;
};
const toggle = (key: keyof EffectsConfig, label: string, hint = '') => `
  <label class="fx-toggle"><input type="checkbox" data-fx-toggle="${key}"><span>${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ''}</span></label>`;

/** 音效设置 panel：对齐上游的布局与参数，沿用莱茵配色。 */
export class AudioEffectsPanel {
  private root?: HTMLElement;
  private keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') this.close(); };
  open(config: EffectsConfig, onChange: (config: EffectsConfig) => void): void {
    this.close();
    let value = normalizeEffectsConfig(config);
    const root = document.createElement('div');
    root.className = 'fx-overlay';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', '音效设置');
    root.innerHTML = `<div class="fx-surface">
      <div class="fx-head"><strong>音效设置</strong>
        <button type="button" class="text-button" data-fx-reset>重置音效</button>
        <button type="button" class="text-button" data-fx-close>关闭</button></div>
      <div class="fx-section"><div class="fx-section-title">音效（原生处理）
          ${toggle('enabled', '启用音效', '改动立即生效 · 从当前位置接着放')}</div>
      </div>
      <div class="fx-section"><div class="fx-section-title">预设
          <span class="fx-hint">16 个内置预设，按场景分类</span></div>
        <div class="fx-presets">${effectsCategories.map(category => {
          const list = effectsPresets.filter(preset => preset.tag === category);
          if (!list.length) return '';
          return `<div class="fx-preset-group"><small>${esc(category)}</small><div class="fx-preset-row">${
            list.map(preset => `<button type="button" class="fx-preset" data-fx-preset="${preset.id}" title="${esc(preset.description)}">${esc(preset.name)}</button>`).join('')
          }</div></div>`;
        }).join('')}</div>
      </div>
      <div class="fx-section"><div class="fx-section-title">十段均衡器
          ${toggle('eqEnabled', '十段均衡器')}</div>
        <svg class="fx-curve" viewBox="0 0 270 70" aria-label="均衡曲线"><polyline data-fx-poly fill="none"></polyline></svg>
        <div class="fx-bands">${eqFrequencies.map((frequency, index) => `
          <label class="fx-band"><input type="range" data-fx-band="${index}" min="-12" max="12" step="0.5" aria-label="${frequency >= 1000 ? `${frequency / 1000}k` : frequency} Hz">
            <output data-fx-band-value="${index}"></output>
            <small>${frequency >= 1000 ? `${frequency / 1000}k` : frequency}</small></label>`).join('')}</div>
      </div>
      <div class="fx-section"><div class="fx-section-title">前级余量</div>
        <div class="fx-preamp-row">${slider('preampDb', '前级余量')}
          <button type="button" class="text-button" data-fx-auto-preamp>自动预留余量</button></div></div>
      <div class="fx-section"><div class="fx-section-title">低音增强
          ${toggle('bassEnabled', '低音增强')}</div>
        ${slider('bassGain', '低音强度')}${slider('bassFreq', '低音频率')}</div>
      <div class="fx-section"><div class="fx-section-title">音色
          <span class="fx-hint">高音与清晰度</span></div>
        ${slider('trebleGain', '高音')}${slider('clarityGain', '清晰度')}</div>
      <div class="fx-section"><div class="fx-section-title">动态控制与主保护</div>
        <div class="fx-grid-2">${slider('compressor', '动态压缩')}${slider('balance', '左右平衡')}</div>
        ${toggle('limiterEnabled', '输出限幅保护')}</div>
      <div class="fx-section"><div class="fx-section-title">空间
          ${toggle('reverbEnabled', '混响空间')}</div>
        ${slider('reverbMix', '混响强度')}</div>
      <div class="fx-section"><div class="fx-section-title">声场
          ${toggle('widenEnabled', '声场加宽')}</div>
        ${slider('widenWidth', '声场宽度')}</div>
      <div class="fx-section"><div class="fx-section-title">旋转声场
          ${toggle('surroundEnabled', '旋转声场')}</div>
        ${slider('surroundSpeed', '旋转速度')}</div>
    </div>`;

    const $ = <T extends Element>(selector: string) => root.querySelector<T>(selector);
    const render = () => {
      for (const input of root.querySelectorAll<HTMLInputElement>('input[data-fx-toggle]')) {
        input.checked = !!value[input.dataset.fxToggle as keyof EffectsConfig];
      }
      for (const input of root.querySelectorAll<HTMLInputElement>('input[data-fx-range]')) {
        const key = input.dataset.fxRange as keyof EffectsConfig;
        input.value = String(value[key]);
        const output = root.querySelector<HTMLOutputElement>(`[data-fx-value="${key}"]`);
        if (output) output.textContent = String(value[key]);
      }
      for (const input of root.querySelectorAll<HTMLInputElement>('input[data-fx-band]')) {
        const index = Number(input.dataset.fxBand);
        input.value = String(value.eqBands[index] ?? 0);
        const output = root.querySelector<HTMLOutputElement>(`[data-fx-band-value="${index}"]`);
        if (output) output.textContent = String(value.eqBands[index] ?? 0);
      }
      const poly = $<SVGPolylineElement>('[data-fx-poly]');
      if (poly) {
 // 对齐上游曲线：x = index*30，y = 35 - gain*1.916
        poly.setAttribute('points', value.eqBands
          .map((gain, index) => `${index * 30},${(35 - (value.eqEnabled ? gain : 0) * 1.916).toFixed(1)}`).join(' '));
      }
      for (const button of root.querySelectorAll<HTMLButtonElement>('[data-fx-preset]')) {
        const preset = effectsPresets.find(item => item.id === button.dataset.fxPreset);
        const current = preset && JSON.stringify(normalizeEffectsConfig({ ...defaultEffectsConfig, ...preset.config, enabled: true })) === JSON.stringify(value);
        button.classList.toggle('is-current', !!current);
      }
    };
    const update = (next: EffectsConfig) => {
      value = normalizeEffectsConfig(next);
      render();
      onChange(value);
    };

    root.addEventListener('input', event => {
      const input = event.target as HTMLInputElement;
      if (input.dataset.fxBand) {
        const bands = [...value.eqBands];
        bands[Number(input.dataset.fxBand)] = Number(input.value);
        update({ ...value, eqBands: bands });
      } else if (input.dataset.fxRange) {
        const key = input.dataset.fxRange as keyof EffectsConfig;
        update({ ...value, [key]: Number(input.value) });
      }
    });
    root.addEventListener('change', event => {
      const input = event.target as HTMLInputElement;
      if (input.dataset.fxToggle) {
        const key = input.dataset.fxToggle as keyof EffectsConfig;
        update({ ...value, [key]: input.checked });
      }
    });
    root.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!button) { if (event.target === root) this.close(); return; }
      if (button.hasAttribute('data-fx-close')) this.close();
      else if (button.hasAttribute('data-fx-reset')) update({ ...defaultEffectsConfig });
      else if (button.hasAttribute('data-fx-auto-preamp')) update({ ...value, preampDb: autoPreamp(value) });
      else if (button.dataset.fxPreset) {
        const preset = effectsPresets.find(item => item.id === button.dataset.fxPreset);
        if (preset) update(applyPreset(value, preset));
      }
    });
    document.addEventListener('keydown', this.keydown);
    document.body.appendChild(root);
    this.root = root;
    render();
  }
  close(): void {
    this.root?.remove(); this.root = undefined;
    document.removeEventListener('keydown', this.keydown);
  }
}
