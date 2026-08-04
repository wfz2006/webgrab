from __future__ import annotations

import json
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    failed_batch_task = {
        "id": "top-level-retry-permission-task",
        "tabId": 17,
        "url": "https://cdn.example.test/batch/video.mp4",
        "kind": "video",
        "fileName": "顶层权限失效批量任务",
        "status": "failed",
        "error": "文件写入权限不足（当前: prompt），请在弹窗中重新选择保存位置",
        "createdAt": 20_000,
        "streamMeta": {
            "kind": "batch",
            "resources": [
                {
                    "url": "https://cdn.example.test/batch/video.mp4",
                    "kind": "video",
                    "ext": "mp4",
                }
            ],
        },
        "diagnostics": [
            {
                "url": "https://cdn.example.test/batch/video.mp4",
                "fileName": "video.mp4",
                "stage": "write",
            }
        ],
    }
    failed_single_task = {
        "id": "top-level-retry-single-task",
        "tabId": 17,
        "url": "https://cdn.example.test/single/video.mp4",
        "kind": "video",
        "fileName": "顶层单文件权限失效.mp4",
        "status": "failed",
        "error": "文件写入权限不足（当前: prompt），请在弹窗中重新选择保存位置",
        "createdAt": 20_001,
    }

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            channel="chromium",
            args=["--allow-file-access-from-files"],
        )
        page = browser.new_page(viewport={"width": 520, "height": 720})
        console_errors: list[str] = []
        page.on(
            "console",
            lambda message: console_errors.append(message.text)
            if message.type == "error"
            else None,
        )
        page.add_init_script(
            f"""
            (() => {{
              const tasks = [{json.dumps(failed_single_task, ensure_ascii=False)}, {json.dumps(failed_batch_task, ensure_ascii=False)}];
              const listeners = [];
              globalThis.__retryPickerCalls = 0;
              globalThis.__startBatchMessages = [];
              globalThis.__startDownloadMessages = [];
              globalThis.showDirectoryPicker = async () => {{
                globalThis.__retryPickerCalls += 1;
                if (globalThis.__retryPickerCalls > 1) {{
                  return {{ kind: 'directory', name: '批量测试目录' }};
                }}
                return {{
                  kind: 'directory',
                  name: '顶层测试目录',
                  async getFileHandle(name, options) {{
                    if (!options?.create) throw new DOMException('missing', 'NotFoundError');
                    return {{ kind: 'file', name }};
                  }},
                }};
              }};
              globalThis.chrome = {{
                tabs: {{ async query() {{ return [{{ id: 17, url: 'https://example.test/gallery' }}]; }} }},
                runtime: {{
                  async sendMessage(message) {{
                    if (message.type === 'GET_RESOURCES') return {{ ok: true, data: {{ resources: [] }} }};
                    if (message.type === 'GET_TASKS') return {{ ok: true, data: {{ tasks }} }};
                    if (message.type === 'START_BATCH_DOWNLOAD') {{
                      globalThis.__startBatchMessages.push(message);
                      return {{ ok: true, data: {{ taskId: 'retried-batch-task' }} }};
                    }}
                    if (message.type === 'START_DOWNLOAD') {{
                      globalThis.__startDownloadMessages.push(message);
                      return {{ ok: true, data: {{ taskId: 'retried-single-task' }} }};
                    }}
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
                        for (const listener of listeners) {{
                          listener({{ [key]: {{ oldValue, newValue: value }} }}, 'local');
                        }}
                      }}
                    }},
                  }},
                  onChanged: {{
                    addListener(listener) {{ listeners.push(listener); }},
                    removeListener(listener) {{
                      const index = listeners.indexOf(listener);
                      if (index >= 0) listeners.splice(index, 1);
                    }},
                  }},
                }},
              }};
            }})();
            """
        )

        page.goto((ROOT / "ui" / "popup.html").as_uri(), wait_until="networkidle")
        assert page.evaluate("window.self === window.top") is True
        page.locator("[data-view='tasks']").click()
        single_card = page.locator("[data-task-id='top-level-retry-single-task']")
        single_card.wait_for()
        single_card.locator(".task-btn-retry").click()
        page.wait_for_function("window.__startDownloadMessages.length === 1")

        card = page.locator("[data-task-id='top-level-retry-permission-task']")
        card.wait_for()
        card.locator(".task-btn-retry").click()

        page.wait_for_function("window.__startBatchMessages.length === 1")
        assert page.evaluate("window.__retryPickerCalls") == 2
        assert page.evaluate("window.__startDownloadMessages[0].type") == "START_DOWNLOAD"
        assert page.evaluate("window.__startBatchMessages[0].type") == "START_BATCH_DOWNLOAD"
        assert page.locator(".task-action-notice").count() == 0
        assert not console_errors, console_errors
        browser.close()


if __name__ == "__main__":
    main()
