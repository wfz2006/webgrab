from __future__ import annotations

import re
import tempfile
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
FIXTURE_URL = "http://127.0.0.1:8765/hostile-page.html"


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *args) -> None:
        pass


def shadow_value(page, expression: str):
    return page.evaluate(
        f"""() => {{
          const root = document.querySelector('webgrab-companion-host')?.shadowRoot;
          if (!root) throw new Error('companion shadow root missing');
          return ({expression});
        }}"""
    )


def main() -> None:
    handler = partial(QuietHandler, directory=str(ROOT / "tests" / "fixtures"))
    server = ThreadingHTTPServer(("127.0.0.1", 8765), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
      with tempfile.TemporaryDirectory(prefix="webgrab-e2e-") as profile_dir:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                profile_dir,
                headless=True,
                channel="chromium",
                viewport={"width": 1100, "height": 760},
                args=[
                    f"--disable-extensions-except={ROOT}",
                    f"--load-extension={ROOT}",
                    "--disable-component-extensions-with-background-pages",
                ],
            )
            page = context.pages[0] if context.pages else context.new_page()
            console_errors: list[str] = []
            page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
            page.goto(FIXTURE_URL, wait_until="networkidle")
            page.bring_to_front()
            worker = context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker")
            page.wait_for_function(
                "document.querySelector('webgrab-companion-host')?.shadowRoot?.querySelector('.wg-trigger')"
            )

            assert page.locator("webgrab-companion-host").count() == 1
            child = page.frame_locator("#child")
            assert child.locator("webgrab-companion-host").count() == 0

            trigger = page.locator("webgrab-companion-host .wg-trigger")
            trigger_style = trigger.evaluate("el => ({background:getComputedStyle(el).backgroundImage,color:getComputedStyle(el).color})")
            assert "linear-gradient" in trigger_style["background"]
            assert trigger_style["color"] != "rgb(255, 0, 0)", trigger_style
            assert shadow_value(page, "root.querySelector('.wg-badge').textContent") != "0"

            # Drag outside the viewport: the pointer path and snap calculation must repair it to the safe edge.
            box = trigger.bounding_box()
            assert box
            page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            page.mouse.down()
            page.mouse.move(-80, -80, steps=6)
            page.mouse.up()
            page.wait_for_timeout(150)
            position = page.locator("webgrab-companion-host").evaluate("el => ({x:el.getBoundingClientRect().x,y:el.getBoundingClientRect().y})")
            assert 7 <= position["x"] <= 9 and 7 <= position["y"] <= 9, position

            stored = worker.evaluate("async () => (await chrome.storage.local.get('webgrab_companion_settings')).webgrab_companion_settings")
            assert stored["positions"]["http://127.0.0.1:8765"] == {"x": 8, "y": 8}

            # Reload proves persistence, then resize proves viewport repair.
            page.reload(wait_until="networkidle")
            page.wait_for_function("document.querySelector('webgrab-companion-host')?.shadowRoot")
            reloaded = page.locator("webgrab-companion-host").evaluate("el => ({x:el.getBoundingClientRect().x,y:el.getBoundingClientRect().y})")
            assert 7 <= reloaded["x"] <= 9 and 7 <= reloaded["y"] <= 9, reloaded
            page.set_viewport_size({"width": 520, "height": 420})
            page.wait_for_timeout(180)
            repaired = page.locator("webgrab-companion-host").evaluate("el => el.getBoundingClientRect().toJSON()")
            assert repaired["x"] >= 0 and repaired["right"] <= 520 and repaired["y"] >= 0 and repaired["bottom"] <= 420, repaired

            # Open the feature-complete popup through panel.html and compare the resource count.
            # First-install onboarding may be the browser's active tab; a real user has to activate
            # the host page before clicking its desktop pet, so reproduce that interaction here.
            page.bring_to_front()
            # The desktop-pet shell intentionally breathes continuously; force the pointer into
            # the moving hit target first, then verify the hover rule pauses it before a normal click.
            trigger.hover(force=True)
            page.wait_for_timeout(80)
            assert shadow_value(page, "getComputedStyle(root.querySelector('.wg-shell')).animationPlayState") == "paused"
            trigger.click()
            page.wait_for_function("!document.querySelector('webgrab-companion-host').shadowRoot.querySelector('.wg-panel').hidden")
            panel_rect = shadow_value(page, "root.querySelector('.wg-panel').getBoundingClientRect().toJSON()")
            assert panel_rect["x"] >= 0 and panel_rect["right"] <= 520 and panel_rect["y"] >= 0 and panel_rect["bottom"] <= 420, panel_rect
            panel_frame = next(frame for frame in page.frames if re.search(r"/ui/panel\.html$", frame.url))
            page.wait_for_timeout(500)
            popup_frames = [frame for frame in page.frames if "popup.html?embedded=1" in frame.url]
            assert popup_frames, [frame.url for frame in page.frames]
            popup_frame = popup_frames[0]
            popup_frame.wait_for_selector('[data-count="all"]')
            badge_count = shadow_value(page, "root.querySelector('.wg-badge').textContent")
            popup_frame.wait_for_function(
                "expected => document.querySelector('[data-count=\"all\"]')?.textContent === expected",
                arg=badge_count,
            )
            popup_count = popup_frame.locator('[data-count="all"]').inner_text()
            assert badge_count == popup_count, (badge_count, popup_count)

            # 嵌套 popup 中的失败重试必须显示卡片内引导，不能触发会被浏览器拒绝的选择器。
            failed_batch_task = {
                "id": "nested-retry-permission-task",
                "tabId": 17,
                "url": "https://cdn.example.test/video.mp4",
                "kind": "video",
                "fileName": "权限失效批量任务",
                "status": "failed",
                "error": "文件写入权限不足（当前: prompt），请在弹窗中重新选择保存位置",
                "createdAt": 20_000,
                "streamMeta": {
                    "kind": "batch",
                    "resources": [{"url": "https://cdn.example.test/video.mp4", "kind": "video", "ext": "mp4"}],
                },
                "diagnostics": [{"url": "https://cdn.example.test/video.mp4", "fileName": "video.mp4", "stage": "write"}],
            }
            failed_single_task = {
                "id": "nested-retry-single-task",
                "tabId": 17,
                "url": "https://cdn.example.test/single.mp4",
                "kind": "video",
                "fileName": "单文件权限失效.mp4",
                "status": "failed",
                "error": "文件写入权限不足（当前: prompt），请在弹窗中重新选择保存位置",
                "createdAt": 20_001,
            }
            worker.evaluate(
                "async tasks => chrome.storage.local.set({webgrab_tasks:tasks})",
                [failed_single_task, failed_batch_task],
            )
            popup_frame.evaluate("window.webgrabTasks.refresh()")
            popup_frame.locator("[data-view='tasks']").click()
            popup_frame.locator("[data-task-id='nested-retry-permission-task']").wait_for()
            popup_frame.evaluate(
                """() => {
                  window.__webgrabRetryPickerCalls = 0;
                  window.showDirectoryPicker = async () => {
                    window.__webgrabRetryPickerCalls += 1;
                    throw new DOMException('blocked in nested frame', 'SecurityError');
                  };
                }"""
            )
            popup_frame.get_by_role("button", name=re.compile(r"重试失败项")).click()
            notice = popup_frame.locator("[data-task-id='nested-retry-permission-task'] .task-action-notice")
            notice.wait_for(state="visible")
            assert "悬浮窗里无法弹出选择框" in notice.inner_text()
            assert "工具栏图标或侧边栏" in notice.inner_text()

            popup_frame.locator("[data-task-id='nested-retry-single-task'] .task-btn-retry").click()
            single_notice = popup_frame.locator("[data-task-id='nested-retry-single-task'] .task-action-notice")
            single_notice.wait_for(state="visible")
            assert "悬浮窗里无法弹出选择框" in single_notice.inner_text()
            assert popup_frame.evaluate("window.__webgrabRetryPickerCalls") == 0
            worker.evaluate("async () => chrome.storage.local.set({webgrab_tasks:[]})")

            panel_frame.locator("#panel-close").focus()
            panel_frame.locator("#panel-close").press("Escape")
            page.wait_for_function("document.querySelector('webgrab-companion-host').shadowRoot.querySelector('.wg-panel').hidden")
            assert shadow_value(page, "root.activeElement?.classList.contains('wg-trigger')") is True

            # Reduced motion fixes the sprite on a single frame.
            page.emulate_media(reduced_motion="reduce")
            page.wait_for_timeout(100)
            animation_name = page.locator("webgrab-companion-host .wg-sprite").evaluate("el => getComputedStyle(el).animationName")
            assert animation_name == "none", animation_name

            # Fullscreen is exercised through a real user gesture when the headless browser supports it.
            fullscreen_supported = page.evaluate("typeof document.documentElement.requestFullscreen === 'function'")
            if fullscreen_supported:
                page.locator("#fullscreen").click()
                page.wait_for_function("document.fullscreenElement !== null")
                page.wait_for_function("document.querySelector('webgrab-companion-host').style.display === 'none'")
                page.evaluate("document.exitFullscreen()")
                page.wait_for_function("document.fullscreenElement === null")
                page.wait_for_function("document.querySelector('webgrab-companion-host').style.display === 'block'")

            # One-click site hiding is persisted and live; restoring storage makes it visible again.
            page.locator("webgrab-companion-host .wg-hide").click(force=True)
            page.wait_for_function("document.querySelector('webgrab-companion-host').style.display === 'none'")
            hidden = worker.evaluate("async () => (await chrome.storage.local.get('webgrab_companion_settings')).webgrab_companion_settings.disabledOrigins")
            assert hidden == ["http://127.0.0.1:8765"], hidden
            worker.evaluate(
                """async () => {
                  const key='webgrab_companion_settings';
                  const value=(await chrome.storage.local.get(key))[key];
                  value.disabledOrigins=[];
                  await chrome.storage.local.set({[key]:value});
                }"""
            )
            page.wait_for_function("document.querySelector('webgrab-companion-host').style.display === 'block'")

            page.set_viewport_size({"width": 1100, "height": 760})
            page.screenshot(path=str(ROOT / "tests" / "floating-companion-smoke.png"), full_page=True)
            assert not [message for message in console_errors if "WebGrab" in message], console_errors
            context.close()
    finally:
      server.shutdown()
      server.server_close()
      thread.join(timeout=3)


if __name__ == "__main__":
    main()
