import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, '..');
const sourcePath = path.join(projectRoot, 'assets', 'icon-src', 'app-icon-source.png');

function inspectIcon(iconPath, size) {
  const script = String.raw`
import json
import sys
from PIL import Image, ImageChops, ImageStat

source_path, icon_path, size_text = sys.argv[1:]
size = int(size_text)

with Image.open(source_path) as source_image:
    source_image.load()
    expected = source_image.convert('RGB').resize(
        (size, size),
        Image.Resampling.LANCZOS,
        reducing_gap=3.0,
    )

with Image.open(icon_path) as icon_image:
    icon_image.load()
    actual = icon_image.convert('RGB')
    difference = ImageChops.difference(actual, expected)
    result = {
        'format': icon_image.format,
        'size': list(icon_image.size),
        'mode': icon_image.mode,
        'variance': ImageStat.Stat(actual).var,
        'matches_source_resize': difference.getbbox() is None,
    }

print(json.dumps(result))
`;

  const result = spawnSync('python', ['-c', script, sourcePath, iconPath, String(size)], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || 'PIL 图标检查脚本执行失败');
  return JSON.parse(result.stdout);
}

for (const size of [16, 48, 128]) {
  test(`扩展图标 ${size}px 是源成品图的精确 Lanczos 缩放`, () => {
    const iconPath = path.join(projectRoot, 'icons', `icon${size}.png`);
    const info = inspectIcon(iconPath, size);

    assert.equal(info.format, 'PNG');
    assert.deepEqual(info.size, [size, size]);
    assert.ok(info.variance.some((value) => value > 0), '图标不能是单一颜色的空图');
    assert.equal(info.matches_source_resize, true, '图标内容必须来自指定成品源图');
  });
}

test('manifest 继续引用三档标准扩展图标', async () => {
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(path.join(projectRoot, 'manifest.json'), 'utf8'));

  assert.deepEqual(manifest.icons, {
    16: 'icons/icon16.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png',
  });
});
