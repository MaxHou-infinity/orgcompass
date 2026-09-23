#!/usr/bin/env python3
"""
V2.4.0 交互测试：三个页面级子界面的一致性 + 人岗核对横幅搬家。

用户要求：
  1. 「人岗核对」不再常驻主页面顶部，收进「组织健康度」；
  2. 「组织健康度」由抽屉弹窗改为**页面级子界面**，与「岗位与编制」一致；
  3. 「胜任度」同样改成子页面。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import App, Failure, Report, load_seed, require_server  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

PAGES = [
    ("岗位与编制", "position-board"),
    ("健康度", "health"),
    ("胜任度", "competency"),
]


def run() -> int:
    require_server()
    rep = Report("V2.4.0 交互测试 · 三个子页面一致性")
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        app = App(browser, viewport=(1800, 1200)).open().expand_all()

        # ── ① 主页面不再有「人岗核对」横幅 ──
        def case_no_banner() -> None:
            rep.check("主页面没有「人岗核对」横幅",
                      app.page.locator('button:has-text("人岗核对")').count() == 0)
            rep.check("画布正常渲染", app.page.locator(".workspace-canvas [data-dept-id]").count() > 0)

        rep.case("① 主页面无诊断横幅", case_no_banner)

        # ── ② 三个入口都进子页面（不是弹窗）──
        def case_all_pages() -> None:
            for label, anchor in PAGES:
                app.page.click(f'.workspace-actions button:has-text("{label}")')
                app.page.wait_for_timeout(900)
                rep.check(f"「{label}」进入子页面", app.page.locator(f'[data-page="{anchor}"]').count() == 1)
                rep.check(f"「{label}」不是弹窗", app.page.locator('[role="dialog"]').count() == 0)
                rep.check(f"「{label}」有「返回画布」",
                          app.page.locator(f'[data-page="{anchor}"] button:has-text("返回画布")').count() == 1)
                rep.check(f"「{label}」打开了就不再显示画布",
                          app.page.locator(".workspace-canvas [data-dept-id]").count() == 0)
                app.page.click('button:has-text("返回画布")')
                app.page.wait_for_timeout(600)
                rep.check(f"「{label}」返回后画布恢复",
                          app.page.locator(".workspace-canvas [data-dept-id]").count() > 0)

        rep.case("② 三个入口都是页面级子界面", case_all_pages)

        # ── ③ 同一时刻只有一个子页面（互不叠加）──
        def case_exclusive() -> None:
            for label, anchor in PAGES:
                app.page.click(f'.workspace-actions button:has-text("{label}")')
                app.page.wait_for_timeout(800)
                visible = [
                    a for _, a in PAGES
                    if app.page.locator(f'[data-page="{a}"]').count() > 0
                ]
                rep.check(f"「{label}」打开时只有它一个子页面", visible == [anchor], f"实际={visible}")
                app.page.click('button:has-text("返回画布")')
                app.page.wait_for_timeout(500)

        rep.case("③ 子页面互斥", case_exclusive)

        # ── ④ 子页面之间可直接切换（不必先回画布）──
        def case_switch_directly() -> None:
            app.page.click('.workspace-actions button:has-text("健康度")')
            app.page.wait_for_timeout(800)
            app.page.click('.workspace-actions button:has-text("胜任度")')
            app.page.wait_for_timeout(900)
            rep.check("健康度 → 胜任度 直接切换成功",
                      app.page.locator('[data-page="competency"]').count() == 1
                      and app.page.locator('[data-page="health"]').count() == 0)
            app.page.click('.workspace-actions button:has-text("岗位与编制")')
            app.page.wait_for_timeout(900)
            rep.check("胜任度 → 岗位与编制 直接切换成功",
                      app.page.locator('[data-page="position-board"]').count() == 1
                      and app.page.locator('[data-page="competency"]').count() == 0)
            app.page.click('button:has-text("返回画布")')
            app.page.wait_for_timeout(500)

        rep.case("④ 子页面之间直接切换", case_switch_directly)

        # ── ⑤ 「人岗核对」搬进健康度（有数据时才出现，且不给二次弹窗）──
        def case_issues_in_health() -> None:
            seed = json.loads(load_seed())
            sc = next(x for x in seed["scenarios"] if x["id"] == seed["currentScenarioId"])
            victim = None

            def collect(ds: list[dict]) -> None:
                nonlocal victim
                for d in ds:
                    for e in d["employees"]:
                        if not e.get("isVirtual") and victim is None:
                            victim = e
                    collect(d.get("children") or [])

            collect(sc["departments"])
            if not rep.check("种子里有员工可构造人岗问题", victim is not None):
                return
            victim["positionId"] = "deleted-position-zzz"
            for e in sc.get("allEmployeesFlat") or []:
                if e["id"] == victim["id"]:
                    e["positionId"] = "deleted-position-zzz"

            app2 = App(browser, seed=seed, viewport=(1800, 1200)).open(2200)
            rep.check("主页面仍然没有横幅（即使存在人岗问题）",
                      app2.page.locator('button:has-text("人岗核对")').count() == 0)
            app2.page.click('.workspace-actions button:has-text("健康度")')
            app2.page.wait_for_timeout(1000)
            section = app2.page.locator("[data-issues-section]")
            if rep.check("健康度页面里出现「人岗核对」区块", section.count() == 1):
                txt = section.inner_text()
                rep.check("区块写明问题项数", "项数据问题" in txt, txt.replace("\n", " ")[:70])
                rep.check("区块直接列出明细（不需要再点开弹窗）",
                          victim["name"] in txt or "岗位不存在" in txt or "归档" in txt)
                rep.check("区块不触发弹窗", app2.page.locator('[role="dialog"]').count() == 0)
            rep.check("健康度页面无控制台错误", not app2.console_errors, "; ".join(app2.console_errors[:2]))
            app2.screenshot("tests/e2e/shots/21-health-issues.png", '[data-page="health"]')
            app2.close()

        rep.case("⑤ 人岗核对收进健康度", case_issues_in_health)

        def case_health() -> None:
            rep.check("全程无控制台错误", not app.console_errors, "; ".join(app.console_errors[:2]))

        rep.case("页面无 JS 错误", case_health)
        app.close()
        browser.close()
    return rep.finish()


if __name__ == "__main__":
    raise SystemExit(run())
