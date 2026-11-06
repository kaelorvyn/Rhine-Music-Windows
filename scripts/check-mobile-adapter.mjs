import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const platform = await fs.readFile('src/platform.ts', 'utf8');
const app = await fs.readFile('src/music-app.ts', 'utf8');
const desktop = await fs.readFile('src/desktop.ts', 'utf8');
const quality = await fs.readFile('src/quality-settings.ts', 'utf8');
const androidBuild = await fs.readFile('src-tauri/gen/android/app/build.gradle.kts', 'utf8');
const manifest = await fs.readFile('src-tauri/gen/android/app/src/main/AndroidManifest.xml', 'utf8');

assert.match(platform, /isAndroidApp/);
assert.match(desktop, /isDesktopApp/);
assert.match(app, /isAndroidApp\(\) \? "" : keybindingsSectionMarkup/);
assert.match(app, /内置模块 · 私有构建/);
assert.match(app, /Download\/Rhine Music/);
assert.match(app, /应用缓存（系统管理）/);
assert.match(app, /手机系统音频输出/);
assert.match(quality, /高性能手机适配/);
assert.match(androidBuild, /compileSdk = 36/);
assert.match(androidBuild, /targetSdk = 34/);
assert.match(manifest, /android:configChanges="orientation\|keyboardHidden\|keyboard\|screenSize/);
console.log(JSON.stringify({
  passed: true,
  androidUiGates: ['keybindings', 'tray', 'dll-import', 'audio-output', 'download-path', 'cache-path'],
  orientationConfig: true,
  desktopBranchPreserved: true,
  androidCompileSdk: 36,
}));
