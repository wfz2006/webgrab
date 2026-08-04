from __future__ import annotations

import json
from pathlib import Path

from playwright.sync_api import Page, sync_playwright


ROOT = Path(__file__).resolve().parents[1]


def contrast_ratio(page: Page, foreground_selector: str, background_selector: str) -> float:
    return page.evaluate(
        r"""([foregroundSelector, backgroundSelector]) => {
          const parse = (value) => value.match(/[\d.]+/g).slice(0, 3).map(Number);
          const luminance = (rgb) => {
            const linear = rgb.map((value) => {
              const channel = value / 255;
              return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
            });
            return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
          };
          const foreground = parse(getComputedStyle(document.querySelector(foregroundSelector)).color);
          const background = parse(getComputedStyle(document.querySelector(backgroundSelector)).backgroundColor);
          const [bright, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
          return (bright + 0.05) / (dark + 0.05);
        }""",
        [foreground_selector, background_selector],
    )


def main() -> None:
    thumb_url = (ROOT / "tests" / "fixtures" / "popup-thumb.svg").as_uri()
    missing_url = (ROOT / "tests" / "fixtures" / "missing-thumb.jpg").as_uri()
    resources = [
        {
            "url": thumb_url,
            "kind": "image",
            "ext": "svg",
            "size": 123456,
            "width": 160,
            "height": 100,
            "title": "章节封面.svg",
            "source": "dom",
            "discoveredAt": 10_000,
        },
        {
            "url": missing_url,
            "kind": "image",
            "ext": "jpg",
            "size": 456789,
            "title": "防盗链缩略图.jpg",
            "source": "network",
            "discoveredAt": 9_999,
        },
    ]
    for index in range(248):
        resources.append(
            {
                "url": f"{thumb_url}?page={index + 3}",
                "kind": "image" if index % 3 else "video",
                "ext": "jpg" if index % 3 else "mp4",
                "size": 200_000 + index * 1024,
                "width": 1280 if index % 3 else None,
                "height": 720 if index % 3 else None,
                "title": f"资源页 {index + 3:03d}",
                "source": "network" if index % 2 else "hook",
                "discoveredAt": 9_000 - index,
            }
        )

    failed_task = {
        "id": "failed-ui-task",
        "tabId": 17,
        "url": "https://cdn.example.test/video.mp4",
        "kind": "video",
        "fileName": "示例失败视频.mp4",
        "status": "failed",
        "error": "SERVER_FORBIDDEN：目标站点拒绝了当前请求",
        "createdAt": 20_000,
        "total": 2_000_000,
        "downloaded": 0,
    }
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            channel="chromium",
            args=["--allow-file-access-from-files"],
        )
        page = browser.new_page(viewport={"width": 520, "height": 720}, color_scheme="dark")
        console_errors: list[str] = []
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        page.add_init_script(
            f"""
            (() => {{
              const resources = {json.dumps(resources, ensure_ascii=False)};
              const tasks = [{json.dumps(failed_task, ensure_ascii=False)}];
              const listeners = [];
              globalThis.chrome = {{
                tabs: {{ async query() {{ return [{{ id: 17, url: 'https://example.test/gallery', title: '演示画廊' }}]; }} }},
                runtime: {{
                  async sendMessage(message) {{
                    if (message.type === 'GET_RESOURCES') return {{ ok: true, data: {{ resources }} }};
                    if (message.type === 'GET_TASKS') return {{ ok: true, data: {{ tasks }} }};
                    if (message.type === 'CLEAR_TAB' || message.type === 'DELETE_TASK') return {{ ok: true }};
                    return {{ ok: true, data: {{}} }};
                  }},
                  onMessage: {{ addListener() {{}} }},
                  async openOptionsPage() {{}},
                }},
                storage: {{
                  local: {{
                    async get(key) {{
                      const value = localStorage.getItem(key);
                      return {{ [key]: value ? JSON.parse(value) : undefined }};
                    }},
                    async set(values) {{
                      for (const [key, value] of Object.entries(values)) {{
                        const oldText = localStorage.getItem(key);
                        const oldValue = oldText ? JSON.parse(oldText) : undefined;
                        localStorage.setItem(key, JSON.stringify(value));
                        for (const listener of listeners) listener({{ [key]: {{ oldValue, newValue: value }} }}, 'local');
                      }}
                    }}
                  }},
                  onChanged: {{ addListener(listener) {{ listeners.push(listener); }}, removeListener(listener) {{ const i=listeners.indexOf(listener); if(i>=0)listeners.splice(i,1); }} }}
                }}
              }};
            }})();
            """
        )
        page.goto((ROOT / "ui" / "popup.html").as_uri(), wait_until="networkidle")
        page.wait_for_selector(".resource-item")
        assert page.locator(".resource-item").count() == 250
        assert page.locator("#batch-bar").is_hidden()

        page.wait_for_function("document.querySelector('.resource-thumb.is-loaded')")
        page.wait_for_function("!document.querySelector('[data-src$=\"missing-thumb.jpg\"]')")
        assert page.locator(".resource-visual .resource-icon").nth(1).is_visible()
        assert contrast_ratio(page, ".resource-name", "body") >= 4.5
        assert contrast_ratio(page, ".resource-meta", "body") >= 4.5

        page.locator(".resource-checkbox").first.check()
        assert page.locator("#batch-bar").is_visible()
        assert page.locator("#batch-count").inner_text() == "已选 1 项"
        page.locator("#batch-cancel").click()
        assert page.locator("#batch-bar").is_hidden()
        assert page.locator(".resource-checkbox:checked").count() == 0

        page.locator("[data-view='tasks']").click()
        page.wait_for_selector(".task-item[data-status='failed']")
        assert page.get_by_role("button", name="重试").is_visible()
        reason = page.locator(".task-error-toggle")
        assert reason.get_attribute("aria-expanded") == "false"
        reason.click()
        assert reason.get_attribute("aria-expanded") == "true"
        assert page.locator(".task-error").is_visible()

        page.locator("[data-view='resources']").click()
        page.locator("#list-container").evaluate("el => { el.scrollTop = el.scrollHeight; }")
        page.wait_for_timeout(150)
        assert page.locator("#list-container").evaluate("el => el.scrollTop > 0")

        page.screenshot(path=str(ROOT / "tests" / "popup-console-dark.png"), full_page=True)
        page.evaluate("chrome.storage.local.set({webgrab_ui_settings:{theme:'light'}})")
        page.wait_for_function("document.documentElement.dataset.theme === 'light'")
        assert contrast_ratio(page, ".resource-name", "body") >= 4.5
        assert contrast_ratio(page, ".resource-meta", "body") >= 4.5
        page.screenshot(path=str(ROOT / "tests" / "popup-console-light.png"), full_page=True)

        page.emulate_media(reduced_motion="reduce")
        duration = page.locator(".resource-thumb").first.evaluate("el => getComputedStyle(el).transitionDuration")
        assert duration in {"0s", "1e-05s"}, duration
        unexpected_errors = [message for message in console_errors if "ERR_FILE_NOT_FOUND" not in message]
        assert not unexpected_errors, unexpected_errors
        browser.close()


if __name__ == "__main__":
    main()
