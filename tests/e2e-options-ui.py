from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            args=["--allow-file-access-from-files"],
        )
        page = browser.new_page(viewport={"width": 1180, "height": 900})
        page.add_init_script(
            """
            globalThis.chrome = {
              storage: {
                local: {
                  async get(key) {
                    const value = localStorage.getItem(key);
                    return { [key]: value ? JSON.parse(value) : undefined };
                  },
                  async set(values) {
                    for (const [key, value] of Object.entries(values)) {
                      localStorage.setItem(key, JSON.stringify(value));
                    }
                  }
                }
              }
            };
            """
        )
        page.goto((ROOT / "ui" / "options.html").as_uri())
        page.wait_for_load_state("networkidle")
        page.wait_for_selector("#path-preview")

        comic_input = page.locator('[data-template-type="comic"]')
        comic_input.focus()
        comic_input.fill("{root}/自定义/{站点}/{序号}_{标题}.{ext}")
        page.select_option("#preview-type", "comic")
        preview = page.locator("#path-preview").inner_text()
        assert preview == "WebGrab/自定义/动漫屋/027_第27回 手链.cbz", preview

        page.locator('input[name="conflict"][value="skip"]').check()
        page.select_option("#ui-theme", "light")
        assert page.locator("html").get_attribute("data-theme") == "light"
        page.get_by_role("button", name="保存设置").click()
        page.wait_for_selector("text=已保存，后续任务将使用新路径。")
        stored = page.evaluate("JSON.parse(localStorage.getItem('webgrab_path_settings'))")
        assert stored["conflictStrategy"] == "skip"
        assert stored["templates"]["comic"] == "{root}/自定义/{站点}/{序号}_{标题}.{ext}"
        stored_ui = page.evaluate("JSON.parse(localStorage.getItem('webgrab_ui_settings'))")
        assert stored_ui == {"theme": "light"}

        page.reload(wait_until="networkidle")
        assert page.locator('[data-template-type="comic"]').input_value() == stored["templates"]["comic"]
        assert page.locator('input[name="conflict"][value="skip"]').is_checked()
        assert page.locator("#ui-theme").input_value() == "light"
        assert page.locator("html").get_attribute("data-theme") == "light"
        page.screenshot(path=str(ROOT / "tests" / "options-ui-smoke.png"), full_page=True)
        browser.close()


if __name__ == "__main__":
    main()
