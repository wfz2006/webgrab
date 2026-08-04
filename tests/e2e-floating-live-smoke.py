from __future__ import annotations

import json
import re
import tempfile
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
SITES = [
    ("bilibili", "https://www.bilibili.com/"),
    ("youtube", "https://www.youtube.com/"),
    ("weibo", "https://weibo.com/"),
]


def main() -> None:
    results = []
    with tempfile.TemporaryDirectory(prefix="webgrab-live-") as profile_dir:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                profile_dir,
                headless=True,
                channel="chromium",
                viewport={"width": 1280, "height": 800},
                args=[f"--disable-extensions-except={ROOT}", f"--load-extension={ROOT}"],
            )
            for name, url in SITES:
                page = context.new_page()
                errors: list[str] = []
                page.on("console", lambda message: errors.append(message.text) if message.type == "error" and "WebGrab" in message.text else None)
                item = {"site": name, "requestedUrl": url}
                try:
                    page.goto(url, wait_until="domcontentloaded", timeout=40000)
                    page.wait_for_timeout(6000)
                    item.update({
                        "finalUrl": page.url,
                        "title": page.title(),
                        "topHosts": page.locator("webgrab-companion-host").count(),
                        "childFrameHosts": sum(frame.locator("webgrab-companion-host").count() for frame in page.frames[1:]),
                        "shadowOpen": page.evaluate("Boolean(document.querySelector('webgrab-companion-host')?.shadowRoot)"),
                        "visible": page.locator("webgrab-companion-host").is_visible() if page.locator("webgrab-companion-host").count() else False,
                        "webgrabConsoleErrors": errors,
                    })
                    if item["visible"]:
                        page.locator("webgrab-companion-host .wg-trigger").click()
                        page.wait_for_timeout(900)
                        popup_frames = [frame for frame in page.frames if re.search(r"/ui/popup\.html\?embedded=1$", frame.url)]
                        if popup_frames:
                            popup = popup_frames[0]
                            popup.wait_for_selector("#list-container")
                            item["panelResourceCount"] = popup.locator(".resource-item").count()
                            item["panelScroll"] = popup.locator("#list-container").evaluate(
                                "el => ({clientHeight:el.clientHeight,scrollHeight:el.scrollHeight})"
                            )
                except PlaywrightTimeoutError as error:
                    item.update({"status": "timeout", "finalUrl": page.url, "error": str(error).splitlines()[0]})
                except Exception as error:  # report actual site behavior without turning it into a fake pass
                    item.update({"status": "error", "finalUrl": page.url, "error": str(error).splitlines()[0]})
                finally:
                    results.append(item)
                    page.close()
            context.close()
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
