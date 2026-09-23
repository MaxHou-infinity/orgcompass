"""
OrgCompass V2.4.0 真实 UI 测试脚手架（Chromium via Playwright）。

为什么要有这一层：`npm run test` 跑的是 vitest + jsdom —— 它不排版、不算像素，
所以「控件被挤出行背景之外」「输入框随文本左右跳」「两行高度不一致」这类缺陷
在 jsdom 里**永远测不出来**（本版已因此漏过两次）。这里用真实 Chromium 补上：

  · 交互测试（test_interaction_*.py）：按真实用户路径点击/输入，断言**应用状态**（读 localStorage 的 .orgproj）
  · 视觉回归（test_visual_*.py）：截图 + **可计算的几何断言**（溢出、换行、对齐、等高）

用法：
    python3 tests/e2e/run.py            # 跑全部
    python3 tests/e2e/run.py interaction
    python3 tests/e2e/run.py visual

前置：`npm run tauri:dev`（或 `npm run dev`）已在 http://localhost:5173 运行。
不依赖 pytest：脚本自己汇总 PASS/FAIL 并以退出码表达结果（0 = 全过）。
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from typing import Any, Callable

BASE_URL = os.environ.get("ORGCOMPASS_URL", "http://localhost:5173/")

# 真实数据种子（35 人 / 6 级 / 15 个岗位；含跨部门同名岗位与一个未配置职级）
SEED_FILE = os.environ.get("ORGCOMPASS_SEED", "/tmp/v232-project.json")


class Failure(AssertionError):
    """断言失败（与脚本自身错误区分开，便于报错分类）。"""


def load_seed() -> str:
    """读取 .orgproj 种子；缺失时回退到空工作区，保证脚本仍可运行。"""
    try:
        with open(SEED_FILE, encoding="utf-8") as f:
            raw = f.read()
        json.loads(raw)  # 提前校验，避免把坏文件塞进 localStorage 后误判成产品 bug
        return raw
    except Exception:  # noqa: BLE001
        return json.dumps({"version": 4, "name": "空工作区", "currentScenarioId": "s1", "scenarios": [
            {"id": "s1", "name": "基线", "departments": [], "allEmployeesFlat": [], "assessments": [],
             "positionAssignments": [], "competencyModel": {"dimensions": []}}]})


def require_server() -> None:
    try:
        with urllib.request.urlopen(BASE_URL, timeout=5) as r:
            if r.status >= 400:
                raise OSError(r.status)
    except Exception as e:  # noqa: BLE001
        raise SystemExit(
            f"✗ 无法连接 {BASE_URL}（{e}）。请先运行 `npm run tauri:dev` 或 `npm run dev`。"
        ) from e


class App:
    """一次测试的运行上下文：浏览器 + 已注入数据的页面 + 常用动作。"""

    def __init__(self, browser: Any, *, seed: str | dict | None = None, viewport: tuple[int, int] = (1800, 1200),
                 scale: float = 1.0, onboarded: bool = True):
        self.browser = browser
        self.ctx = browser.new_context(
            viewport={"width": viewport[0], "height": viewport[1]},
            device_scale_factor=scale,
        )
        # seed 允许传 str（.orgproj 原文）或 dict（就地构造/改写的项目对象）。
        # 必须**双重编码**：先确保是字符串，再 json.dumps 一次，嵌进 JS 才是字符串字面量。
        # 踩过的坑：直接把 dict 的 json.dumps 结果写进 setItem(...) 会变成 JS 对象字面量，
        # localStorage 收到的是 "[object Object]" → 应用如实报"自动保存内容无法读取"。
        raw = seed if seed is not None else load_seed()
        if not isinstance(raw, str):
            raw = json.dumps(raw)
        seed_json = json.dumps(raw)
        self.ctx.add_init_script(
            "localStorage.clear();"
            + ("localStorage.setItem('org-designer.onboarded','1');" if onboarded else "")
            + "localStorage.setItem('org-designer.display-hint','1');"
            + f"localStorage.setItem('org-designer.project.v2', {seed_json});"
        )
        self.page = self.ctx.new_page()
        self.console_errors: list[str] = []
        self.page.on("console", lambda m: self.console_errors.append(m.text) if m.type == "error" else None)
        self.page.on("pageerror", lambda e: self.console_errors.append(str(e)))

    # —— 生命周期 ——
    def open(self, wait: int = 2200) -> "App":
        self.page.goto(BASE_URL)
        self.page.wait_for_timeout(wait)
        return self

    def close(self) -> None:
        self.ctx.close()

    # —— 常用动作 ——
    def expand_all(self, rounds: int = 14) -> "App":
        """反复点「展开全部」，直到画布上没有可展开的部门卡。"""
        for _ in range(rounds):
            btn = self.page.locator('button:has-text("展开全部")')
            if btn.count() == 0:
                break
            try:
                btn.first.click(timeout=1500)
            except Exception:  # noqa: BLE001
                break
            self.page.wait_for_timeout(80)
        self.page.wait_for_timeout(300)
        return self

    def open_toolbar(self, label: str, wait: int = 900) -> "App":
        self.page.click(f'.workspace-actions button:has-text("{label}"), header button:has-text("{label}")')
        self.page.wait_for_timeout(wait)
        return self

    def dialog(self, name: str):
        """
        按**可访问名**定位弹窗。

        踩坑记录：`AppModal` 用的是 `aria-labelledby`（不是 `aria-label`），
        所以 `[role="dialog"][aria-label="..."]` 这种 CSS 选择器**匹配不到** ——
        弹窗明明开着却报"没打开"。必须走 role+name 的可访问名计算。
        """
        return self.page.get_by_role("dialog", name=name)

    def tooltip_texts(self) -> list[str]:
        return self.page.evaluate(
            "() => [...document.querySelectorAll('[title]')].map(e => e.getAttribute('title'))"
        )

    def project(self) -> dict:
        """读回应用真实落盘的 .orgproj（经 lz16 解压）。"""
        return self.page.evaluate(
            """async () => {
              const raw = localStorage.getItem('org-designer.project.v2') || '';
              const mod = await import('/src/utils/project.ts');
              return mod.parseProject(mod.decodeStoredProject(raw));
            }"""
        )

    def screenshot(self, path: str, selector: str | None = None) -> None:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if selector:
            self.page.locator(selector).first.screenshot(path=path)
        else:
            self.page.screenshot(path=path)


# ───────────────────────── 断言与报告 ─────────────────────────

class Report:
    def __init__(self, title: str):
        self.title = title
        self.rows: list[tuple[str, bool, str]] = []

    def check(self, name: str, cond: bool, detail: str = "") -> bool:
        self.rows.append((name, bool(cond), detail))
        mark = "✓" if cond else "✗"
        print(f"  {mark} {name}" + (f"  [{detail}]" if detail else ""))
        return bool(cond)

    def case(self, name: str, fn: Callable[[], None]) -> None:
        print(f"\n▸ {name}")
        try:
            fn()
        except Failure as e:
            self.rows.append((name, False, str(e)))
            print(f"  ✗ {name} → {e}")
        except Exception as e:  # noqa: BLE001
            self.rows.append((name, False, f"{type(e).__name__}: {e}"))
            print(f"  ✗ {name} → {type(e).__name__}: {e}")

    def finish(self) -> int:
        failed = [r for r in self.rows if not r[1]]
        print(f"\n{'=' * 62}")
        print(f"{self.title}：{len(self.rows) - len(failed)}/{len(self.rows)} 项通过")
        for name, _, detail in failed:
            print(f"  ✗ {name}  {detail}")
        print("=" * 62)
        return 1 if failed else 0
