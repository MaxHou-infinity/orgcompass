#!/usr/bin/env python3
"""
V2.4.0 交互测试：部门删除 + 新建部门的层级归属限制。

来源：用户实测反馈 —— 从左侧「新建部门」建出的部门**删不掉**（右键只有「调整层级归属」）；
且新建时的「归属部门」下拉把所有部门平铺，选同级/下级也能建出来。

两条规则：
  1. 删除：(a) 空部门允许；(b) 仍有员工 → 弹说明要求先挪人。
  2. 归属：不得归属同级或下级；可不指定归属。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import App, Failure, Report, require_server  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402


def snapshot(app: App) -> dict:
    """当前场景的部门结构快照：{deptId: (name, level, 直属真人数, 子部门数)}"""
    project = app.project()
    sc = next(s for s in project["scenarios"] if s["id"] == project["currentScenarioId"])
    out: dict[str, tuple] = {}

    def walk(ds: list[dict]) -> None:
        for d in ds:
            out[d["id"]] = (
                d["name"], d.get("level"),
                len([e for e in d["employees"] if not e.get("isVirtual")]),
                len(d.get("children") or []),
            )
            walk(d.get("children") or [])

    walk(sc["departments"])
    return out


def first_empty_leaf(snap: dict) -> str | None:
    for did, (_, _, emps, kids) in snap.items():
        if emps == 0 and kids == 0:
            return did
    return None


def first_with_employees(snap: dict) -> str | None:
    for did, (_, _, emps, _) in snap.items():
        if emps > 0:
            return did
    return None


def run() -> int:
    require_server()
    rep = Report("V2.4.0 交互测试 · 部门删除与归属限制")
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        app = App(browser, viewport=(1900, 1200)).open().expand_all()
        snap = snapshot(app)
        busy_id = first_with_employees(snap)
        # 真实数据里没有「空的叶子部门」，所以按用户实际路径**通过界面新建一个**再测删除
        holder: dict = {}

        def open_menu(dept_id: str):
            header = app.page.locator(f'[data-dept-id="{dept_id}"] [data-dept-header]').first
            header.click(button="right")
            app.page.wait_for_timeout(350)

        # ── ① 用左侧「新建部门」建一个空部门（用户报的就是这条路径）──
        def case_create_empty() -> None:
            app.page.click('button:has-text("新建部门")')
            app.page.wait_for_timeout(400)
            app.page.locator('select[aria-label="部门层级"]').select_option("1")
            app.page.wait_for_timeout(200)
            app.page.locator('input[aria-label="部门名称"]').fill("E2E 待删部门")
            app.page.click('button:has-text("创建")')
            app.page.wait_for_timeout(1000)
            after = snapshot(app)
            created = [i for i, v in after.items() if v[0] == "E2E 待删部门"]
            if not rep.check("新建部门成功", len(created) == 1):
                raise Failure("未创建成功")
            holder["empty_id"] = created[0]
            rep.check("它是空部门（无成员、无子部门）",
                      after[created[0]][2] == 0 and after[created[0]][3] == 0)

        rep.case("① 新建一个空部门", case_create_empty)

        # ── ①b 右键菜单出现删除入口 ──
        def case_menu() -> None:
            did = holder["empty_id"]
            open_menu(did)
            item = app.page.locator("[data-dept-delete]")
            rep.check("部门右键菜单有「删除该部门」（旧实现只有「调整层级归属」）", item.count() == 1)
            if item.count():
                rep.check("菜单项文案正确", "删除该部门" in item.first.inner_text())
            app.page.mouse.click(5, 5)
            app.page.wait_for_timeout(250)

        rep.case("①b 删除入口存在", case_menu)

        # ── ② 有员工的部门 → 拒绝并说明 ──
        def case_blocked() -> None:
            if not rep.check("种子里有含员工的部门", busy_id is not None):
                raise Failure("没有含员工的部门")
            before = snapshot(app)
            open_menu(busy_id)
            app.page.locator("[data-dept-delete]").first.click()
            app.page.wait_for_timeout(600)
            dlg = app.dialog("无法删除部门")
            # 标题带部门名 → 用正则不行，改用文本定位
            if dlg.count() == 0:
                dlg = app.page.locator('[role="dialog"]').filter(has_text="无法删除部门")
            rep.check("弹出说明弹窗", dlg.count() >= 1)
            if dlg.count():
                txt = dlg.first.inner_text()
                rep.check("说明里要求先挪人", "请先把他们挪到其他部门" in txt, txt.replace("\n", " ")[:80])
                rep.check("说明里列出了具体是谁", before[busy_id][0] in txt or "员工" in txt)
                dlg.first.locator('button:has-text("知道了")').click()
            app.page.wait_for_timeout(500)
            after = snapshot(app)
            rep.check("部门**没有**被删除", busy_id in after)
            rep.check("结构完全未变", before == after)

        rep.case("② 有员工的部门拒绝删除", case_blocked)

        # ── ③ 空部门 → 确认后删除 ──
        def case_delete_empty() -> None:
            empty_id = holder["empty_id"]
            before = snapshot(app)
            open_menu(empty_id)
            app.page.locator("[data-dept-delete]").first.click()
            app.page.wait_for_timeout(600)
            dlg = app.page.locator('[role="dialog"]').filter(has_text="确认删除部门")
            rep.check("弹出确认弹窗", dlg.count() >= 1)
            if dlg.count():
                rep.check("确认文案说明不影响人员", "不影响任何人员" in dlg.first.inner_text())
                dlg.first.locator('button:has-text("确认执行")').click()
            app.page.wait_for_timeout(900)
            after = snapshot(app)
            rep.check("空部门已从工作区删除", empty_id not in after, f"剩余 {len(after)} 个部门")
            rep.check("其余部门一个不少", len(after) == len(before) - 1, f"{len(before)} → {len(after)}")
            rep.check("画布上该卡片消失", app.page.locator(f'[data-dept-id="{empty_id}"]').count() == 0)

        rep.case("③ 空部门可删除", case_delete_empty)

        # ── ④ 新建部门：归属下拉只列层级更浅的部门 ──
        def case_parent_filter() -> None:
            app.page.click('button:has-text("新建部门")')
            app.page.wait_for_timeout(400)
            lvl = app.page.locator('select[aria-label="部门层级"]')
            parent = app.page.locator('select[aria-label="归属部门"]')
            rep.check("新建部门表单打开", lvl.count() == 1 and parent.count() == 1)

            structure = snapshot(app)
            for level in (2, 3, 4):
                lvl.select_option(str(level))
                app.page.wait_for_timeout(200)
                opts = parent.evaluate("(s) => [...s.options].map(o => o.value)")
                ids = [v for v in opts if v != "root"]
                bad = [i for i in ids if structure.get(i) and structure[i][1] >= level]
                rep.check(f"L{level}：归属候选里没有同级/下级部门", not bad,
                          f"非法={[ (structure[i][0], structure[i][1]) for i in bad ]}")
                expected = [i for i, v in structure.items() if v[1] < level]
                rep.check(f"L{level}：候选集合等于「层级更浅的部门」", sorted(ids) == sorted(expected),
                          f"候选 {len(ids)} / 期望 {len(expected)}")
                hint = app.page.locator("[data-dept-parent-hint]").inner_text()
                rep.check(f"L{level}：提示写明不得归属同级或下级", "不得归属同级或下级部门" in hint)

            lvl.select_option("1")
            app.page.wait_for_timeout(200)
            opts = parent.evaluate("(s) => [...s.options].map(o => o.value)")
            rep.check("L1：没有可归属的上级，只剩「暂不指定」", opts == ["root"], f"实际={opts}")
            app.page.locator('button:has-text("取消")').first.click()
            app.page.wait_for_timeout(300)

        rep.case("④ 归属下拉按层级过滤", case_parent_filter)

        # ── ⑤ 合法归属能建出来，并能再删掉（闭环）──
        def case_create_and_delete() -> None:
            app.page.click('button:has-text("新建部门")')
            app.page.wait_for_timeout(400)
            app.page.locator('select[aria-label="部门层级"]').select_option("2")
            app.page.wait_for_timeout(200)
            parent = app.page.locator('select[aria-label="归属部门"]')
            first_dept = parent.evaluate("(s) => [...s.options].map(o => o.value).find(v => v !== 'root')")
            if not rep.check("L2 至少有一个合法上级可选", first_dept is not None):
                raise Failure("没有 L1 部门")
            parent.select_option(first_dept)
            app.page.locator('input[aria-label="部门名称"]').fill("E2E 新部门")
            app.page.click('button:has-text("创建")')
            app.page.wait_for_timeout(1000)
            after = snapshot(app)
            created = [i for i, v in after.items() if v[0] == "E2E 新部门"]
            rep.check("新部门已创建", len(created) == 1)
            if created:
                did = created[0]
                rep.check("层级为 L2", after[did][1] == 2)
                rep.check("挂在所选上级下", after[first_dept][3] >= 1)
                # 新建的空部门应当可以立刻删除
                open_menu(did)
                app.page.locator("[data-dept-delete]").first.click()
                app.page.wait_for_timeout(600)
                dlg = app.page.locator('[role="dialog"]').filter(has_text="确认删除部门")
                if rep.check("新建的空部门可删除（闭环）", dlg.count() >= 1):
                    dlg.first.locator('button:has-text("确认执行")').click()
                    app.page.wait_for_timeout(900)
                    rep.check("删除成功", did not in snapshot(app))

        rep.case("⑤ 建得出来也删得掉（闭环）", case_create_and_delete)

        def case_health() -> None:
            rep.check("全程无控制台错误", not app.console_errors, "; ".join(app.console_errors[:2]))

        rep.case("页面无 JS 错误", case_health)
        app.close()
        browser.close()
    return rep.finish()


if __name__ == "__main__":
    raise SystemExit(run())
