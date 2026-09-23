#!/usr/bin/env python3
"""
V2.4.0 交互测试：「岗位与编制」页面级子界面。

驱动真实界面完成用户描述的六件事，并断言**落盘的工作区**与页面几何：
  ① 从顶部进入子界面（不是弹窗）  ② 看到所有岗位与人数
  ③ 改编制 → 缺/超即时变化        ④ 新增 / 编辑 / 删除岗位
  ⑤ 套岗（候选人显示现属部门›岗位）⑥ 删除岗位后「无明确岗位」持续可见
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import App, Failure, Report, require_server  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

PAGE = '[data-page="position-board"]'


def find_position(project: dict, name: str, dept_name: str | None = None) -> tuple[dict, dict] | None:
    hits: list[tuple[dict, dict]] = []

    def walk(ds: list[dict]) -> None:
        for d in ds:
            for p in d.get("positions") or []:
                if p["name"] == name and (dept_name is None or d["name"] == dept_name):
                    hits.append((d, p))
            walk(d.get("children") or [])

    for s in project["scenarios"]:
        walk(s["departments"])
    return hits[0] if hits else None


def run() -> int:
    require_server()
    rep = Report("V2.4.0 交互测试 · 岗位与编制子界面")
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        app = App(browser, viewport=(1800, 1200)).open().expand_all()

        def case_enter() -> None:
            rep.check("进入前画布在渲染", app.page.locator(".workspace-canvas [data-dept-id]").count() > 0)
            app.page.click('button:has-text("岗位与编制")')
            app.page.wait_for_timeout(900)
            rep.check("进入的是**页面级**子界面（不是弹窗）", app.page.locator(PAGE).count() == 1)
            rep.check("页面上没有弹窗残留", app.page.locator('[role="dialog"]').count() == 0)
            rep.check("画布已让位（不再渲染部门卡）", app.page.locator(".workspace-canvas [data-dept-id]").count() == 0)
            rep.check("页面标题为「岗位与编制」", "岗位与编制" in app.page.locator(PAGE).inner_text())

        rep.case("① 进入子界面", case_enter)

        def case_inventory() -> None:
            project = app.project()
            live = 0
            for s in project["scenarios"]:
                if s["id"] != project["currentScenarioId"]:
                    continue

                def walk(ds: list[dict]) -> None:
                    nonlocal live
                    for d in ds:
                        live += len([p for p in (d.get("positions") or []) if p.get("status") != "archived"])
                        walk(d.get("children") or [])

                walk(s["departments"])
            shown = app.page.locator("[data-position-row]").count()
            rep.check("表格列出全部有效岗位", shown == live, f"界面 {shown} / 数据 {live}")
            txt = app.page.locator(PAGE).inner_text()
            for label in ("编制合计", "在岗合计", "待补人数", "超额人数", "未配置编制"):
                rep.check(f"汇总条含「{label}」", label in txt)
            rep.check("每行给出职级带宽列", "职级带宽" in txt)
            rep.check("每行给出在岗人员列", "在岗人员" in txt)

        rep.case("② 看到所有岗位与人数", case_inventory)

        def case_edit_headcount() -> None:
            # 挑一个「在岗 > 0」的岗位：把编制设成 在岗+2，缺口应变成「缺 2」
            info = app.page.evaluate(
                """() => {
                  const rows = [...document.querySelectorAll('[data-position-row]')];
                  for (const r of rows) {
                    const occ = +(r.children[3].textContent.trim() || '0');
                    if (occ > 0) return { id: r.getAttribute('data-position-row'), occ };
                  }
                  return null;
                }"""
            )
            if not rep.check("找到在岗人数 > 0 的岗位", info is not None):
                raise Failure("没有在岗岗位")
            pid, occ = info["id"], info["occ"]
            row = app.page.locator(f'[data-position-row="{pid}"]')
            inp = row.locator('input[type="number"]')
            before = inp.input_value()
            inp.fill(str(occ + 2))
            inp.blur()
            app.page.wait_for_timeout(900)
            after_row_text = app.page.locator(f'[data-position-row="{pid}"]').inner_text()
            rep.check("改编制后缺口即时变为「缺 2」", "缺 2" in after_row_text, after_row_text.replace("\n", " ")[:80])
            project = app.project()
            hit = None
            for s in project["scenarios"]:
                def walk(ds: list[dict]) -> None:
                    nonlocal hit
                    for d in ds:
                        for p in d.get("positions") or []:
                            if p["id"] == pid:
                                hit = p
                        walk(d.get("children") or [])

                walk(s["departments"])
            rep.check("编制已真实落盘", hit is not None and hit["headcount"] == occ + 2,
                      f"落盘={hit and hit['headcount']} 原值={before}")
            # 还原
            app.page.locator(f'[data-position-row="{pid}"] input[type="number"]').fill(before)
            app.page.locator(f'[data-position-row="{pid}"] input[type="number"]').blur()
            app.page.wait_for_timeout(700)
            return pid

        holder: dict = {}

        def case_edit_headcount_wrap() -> None:
            holder["pid"] = case_edit_headcount()

        rep.case("③ 编制可就地编辑并即时算缺口", case_edit_headcount_wrap)

        def case_create_position() -> None:
            app.page.click('button:has-text("新增岗位")')
            app.page.wait_for_timeout(300)
            row = app.page.locator("[data-create-position-row]")
            rep.check("新增岗位表单展开", row.count() == 1)
            dept = row.locator('select[aria-label="新岗位目标部门"]')
            dept_id = dept.evaluate("(s) => s.options[0].value")
            row.locator('input[aria-label="新岗位名称"]').fill("E2E 品牌经理")
            row.locator('input[aria-label="新岗位编制"]').fill("3")
            row.locator('button:has-text("创建")').click()
            app.page.wait_for_timeout(900)
            project = app.project()
            hit = None

            def walk(ds: list[dict]) -> None:
                nonlocal hit
                for d in ds:
                    for p in d.get("positions") or []:
                        if p["name"] == "E2E 品牌经理":
                            hit = (d, p)
                    walk(d.get("children") or [])

            for s in project["scenarios"]:
                walk(s["departments"])
            rep.check("新岗位已创建并落盘", hit is not None)
            if hit:
                rep.check("落在所选部门", hit[0]["id"] == dept_id, f"实际={hit[0]['name']}")
                rep.check("编制按填写值", hit[1]["headcount"] == 3, f"headcount={hit[1]['headcount']}")
            rep.check("表格出现新岗位行", "E2E 品牌经理" in app.page.locator(PAGE).inner_text())

        rep.case("④ 新增岗位", case_create_position)

        def case_edit_position() -> None:
            project = app.project()
            found = None
            for s in project["scenarios"]:
                def walk(ds: list[dict]) -> None:
                    nonlocal found
                    for d in ds:
                        for p in d.get("positions") or []:
                            if p["name"] == "E2E 品牌经理":
                                found = p
                        walk(d.get("children") or [])

                walk(s["departments"])
            if not rep.check("新岗位存在", found is not None):
                raise Failure("新岗位未找到")
            pid = found["id"]
            row = app.page.locator(f'[data-position-row="{pid}"]')
            row.locator('button:has-text("编辑")').click()
            app.page.wait_for_timeout(300)
            edit = app.page.locator(f'[data-edit-position-row="{pid}"]')
            rep.check("行内编辑表单展开", edit.count() == 1)
            edit.locator('input[aria-label="编辑岗位名称"]').fill("E2E 品牌市场经理")
            edit.locator('button:has-text("保存")').click()
            app.page.wait_for_timeout(900)
            project = app.project()
            name = None

            def walk2(ds: list[dict]) -> None:
                nonlocal name
                for d in ds:
                    for p in d.get("positions") or []:
                        if p["id"] == pid:
                            name = p["name"]
                    walk2(d.get("children") or [])

            for s in project["scenarios"]:
                walk2(s["departments"])
            rep.check("岗位改名已落盘", name == "E2E 品牌市场经理", f"实际={name}")
            rep.check("表格显示新名称", "E2E 品牌市场经理" in app.page.locator(PAGE).inner_text())
            return pid

        holder2: dict = {}

        def case_edit_position_wrap() -> None:
            holder2["pid"] = case_edit_position()

        rep.case("④ 编辑岗位", case_edit_position_wrap)

        def case_assign() -> None:
            # 挑一个有候选人的岗位（用刚建的：目前无人）
            pid = holder2["pid"]
            row = app.page.locator(f'[data-position-row="{pid}"]')
            row.locator('button:has-text("套岗")').click()
            app.page.wait_for_timeout(400)
            panel = app.page.locator(f'[data-assign-row="{pid}"]')
            rep.check("候选人面板展开", panel.count() == 1)
            first = panel.locator("[data-candidate]").first
            cand_text = first.inner_text()
            rep.check("候选人显示现属部门与现属岗位", "现属" in cand_text and "›" in cand_text, cand_text[:60])
            cand_id = first.get_attribute("data-candidate")
            first.click()
            app.page.wait_for_timeout(1000)
            project = app.project()
            moved = None
            emp_name = None
            for s in project["scenarios"]:
                for e in s.get("allEmployeesFlat") or []:
                    if e["id"] == cand_id:
                        moved, emp_name = e.get("positionId"), e["name"]

                def walk(ds: list[dict]) -> None:
                    for d in ds:
                        for e in d["employees"]:
                            if e["id"] == cand_id:
                                nonlocal moved
                                moved = e.get("positionId")
                        walk(d.get("children") or [])

                walk(s["departments"])
            rep.check("套岗后该员工岗位已改为目标岗位", moved == pid, f"实际={moved}")
            rep.check("行内在岗人员出现该员工", emp_name in app.page.locator(f'[data-position-row="{pid}"]').inner_text())

        rep.case("⑤ 套岗（候选人可辨识）", case_assign)

        def case_delete_and_banner() -> None:
            pid = holder2["pid"]
            row = app.page.locator(f'[data-position-row="{pid}"]')
            row.locator('button:has-text("删除")').click()
            app.page.wait_for_timeout(500)
            dlg = app.dialog("确认归档岗位")
            rep.check("删除前弹出影响确认", dlg.count() == 1)
            if dlg.count():
                rep.check("确认文案列出受影响人员", "E2E" in dlg.inner_text() or "将结束" in dlg.inner_text(),
                          dlg.inner_text().replace("\n", " ")[:70])
                dlg.locator('button:has-text("确认执行")').click()
            app.page.wait_for_timeout(900)
            project = app.project()
            archived = None

            def walk(ds: list[dict]) -> None:
                nonlocal archived
                for d in ds:
                    for p in d.get("positions") or []:
                        if p["id"] == pid:
                            archived = p["status"]
                    walk(d.get("children") or [])

            for s in project["scenarios"]:
                walk(s["departments"])
            rep.check("岗位已归档（软删除）", archived == "archived", f"status={archived}")
            rep.check("岗位行从表格消失", app.page.locator(f'[data-position-row="{pid}"]').count() == 0)

            banner = app.page.locator("[data-positionless-banner]")
            rep.check("出现「无明确岗位」持续提示位", banner.count() == 1)
            if banner.count():
                txt = banner.inner_text()
                rep.check("提示位写明人数", "名员工处于无明确岗位状态" in txt, txt.replace("\n", " ")[:60])
                rep.check("提示位区分「岗位已删除」与「未套岗」", "岗位已删除" in txt or "未套岗" in txt)
                rep.check("提示位给出处置建议", "新建岗位" in txt and "套岗" in txt)
            # 它是**常驻**的：切走再回来仍在
            app.page.click('button:has-text("返回画布")')
            app.page.wait_for_timeout(600)
            app.page.click('button:has-text("岗位与编制")')
            app.page.wait_for_timeout(700)
            rep.check("提示位是常驻状态（离开再回来仍在）",
                      app.page.locator("[data-positionless-banner]").count() == 1)

        rep.case("⑥ 删除岗位 + 无岗位员工持续提示", case_delete_and_banner)

        def case_view_toggle() -> None:
            app.page.click('button:has-text("按岗位")')
            app.page.wait_for_timeout(500)
            rep.check("切到「按岗位」视图", app.page.locator("[data-position-name-row]").count() > 0)
            # 真实数据里「生产工艺工程师」「生产制造操作员」各跨 2 个部门
            merged = app.page.locator('[data-position-name-row]:has-text("分布在")')
            rep.check("同名跨部门岗位被标注分布", merged.count() > 0, f"合并行 {merged.count()} 个")
            if merged.count():
                label = merged.first.inner_text()
                rep.check("标注写出部门数", "分布在 2 个部门" in label, label.replace("\n", " ")[:60])
                merged.first.locator("button").first.click()
                app.page.wait_for_timeout(400)
                rep.check("展开后出现各部门明细行", app.page.locator("[data-subrow]").count() >= 2)
            app.page.click('button:has-text("按部门")')
            app.page.wait_for_timeout(400)

        rep.case("⑦ 按岗位聚合视图", case_view_toggle)

        def case_back() -> None:
            app.page.click('button:has-text("返回画布")')
            app.page.wait_for_timeout(700)
            rep.check("返回后画布恢复", app.page.locator(".workspace-canvas [data-dept-id]").count() > 0)
            rep.check("子界面已卸载", app.page.locator(PAGE).count() == 0)

        rep.case("⑧ 返回画布", case_back)

        def case_health() -> None:
            rep.check("全程无控制台错误", not app.console_errors, "; ".join(app.console_errors[:2]))

        rep.case("页面无 JS 错误", case_health)
        app.close()
        browser.close()
    return rep.finish()


if __name__ == "__main__":
    raise SystemExit(run())
