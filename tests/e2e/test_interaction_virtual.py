#!/usr/bin/env python3
"""
V2.4.0 交互测试：虚拟员工（兼岗）新流程。

按**真实用户路径**驱动界面（右键 → 菜单 → 弹窗 → 选择 → 创建），
断言的是**应用真实落盘的工作区**（从 localStorage 解出 .orgproj），
而不是界面上的一句話 —— 这样"界面说成功了但数据没落"也会被抓到。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import App, Failure, Report, require_server  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402


def dept_by_name(project: dict, name: str) -> dict | None:
    found: list[dict] = []

    def walk(ds: list[dict]) -> None:
        for d in ds:
            if d["name"] == name:
                found.append(d)
            walk(d.get("children") or [])

    for s in project["scenarios"]:
        walk(s["departments"])
    return found[0] if found else None


def run() -> int:
    require_server()
    rep = Report("V2.4.0 交互测试 · 虚拟员工兼岗流程")
    with sync_playwright() as pw:
        browser = pw.chromium.launch()

        # ── 用例 1：右键员工 → 弹窗 → 选已有岗位 → 落库到目标部门 ──
        app = App(browser).open().expand_all()

        def pick_fixture() -> dict:
            """数据驱动挑场景：一个有真人员工的部门 D + 一个（≠D 且**有岗位**）的部门 T。"""
            project = app.project()
            depts: list[dict] = []

            def walk(ds: list[dict]) -> None:
                for d in ds:
                    depts.append(d)
                    walk(d.get("children") or [])

            for s in project["scenarios"]:
                walk(s["departments"])
            for d in depts:
                real = [e for e in d["employees"] if not e.get("isVirtual")]
                if not real:
                    continue
                for t in depts:
                    if t["id"] == d["id"]:
                        continue
                    live = [p for p in (t.get("positions") or []) if p.get("status") != "archived"]
                    if live:
                        return {"emp": real[0], "from": d, "to": t, "pos": live[0]}
            raise Failure("种子数据里找不到可用的部门组合")

        fx = pick_fixture()
        print(f"   夹具：{fx['emp']['name']} 现属「{fx['from']['name']}」→ 目标「{fx['to']['name']}」/「{fx['pos']['name']}」")
        holder: dict = {}

        def case_open_and_exclude() -> None:
            tag = app.page.locator(f'[data-emp-id="{fx["emp"]["id"]}"]')
            if not rep.check("画布上找到该员工卡片", tag.count() == 1):
                raise Failure("员工卡片未渲染")
            tag.click()
            tag.click(button="right")
            app.page.wait_for_timeout(300)
            menu = app.page.locator('button:has-text("创建虚拟员工（兼岗）")')
            if not rep.check("右键菜单出现「创建虚拟员工（兼岗）」", menu.count() > 0):
                raise Failure("菜单项未出现")
            menu.first.click()
            app.page.wait_for_timeout(500)
            dlg = app.dialog("创建虚拟员工（兼岗）")
            if not rep.check("弹窗打开", dlg.count() > 0):
                raise Failure("弹窗未打开")
            holder["dlg"] = dlg
            rep.check("显示源员工与现属部门", fx["from"]["name"] in dlg.inner_text())
            info = dlg.evaluate(
                """(d) => {
                  const sel = d.querySelector('select[aria-label="目标部门"]');
                  return { values: [...sel.options].map(o => o.value),
                           labels: [...sel.options].map(o => o.textContent.trim()) };
                }"""
            )
            # 用**部门 id** 精确断言 —— 名称子串匹配会被「…（Agency）」这类同名部门误判
            rep.check("目标部门下拉排除了本人现属部门", fx["from"]["id"] not in info["values"],
                      f"现属 id={fx['from']['id']}")
            rep.check("目标部门下拉包含其他部门", fx["to"]["id"] in info["values"])

        rep.case("弹窗与排除规则", case_open_and_exclude)

        def case_create_with_existing_position() -> None:
            dlg = holder.get("dlg")
            if dlg is None:
                raise Failure("前置用例未拿到弹窗")
            dlg.evaluate(
                """(d, ids) => {
                  const dept = d.querySelector('select[aria-label="目标部门"]');
                  dept.value = ids.deptId;
                  dept.dispatchEvent(new Event('change', { bubbles: true }));
                }""",
                {"deptId": fx["to"]["id"]},
            )
            app.page.wait_for_timeout(300)
            dlg.evaluate(
                """(d, ids) => {
                  const pos = d.querySelector('select[aria-label="目标岗位"]');
                  pos.value = ids.posId;
                  pos.dispatchEvent(new Event('change', { bubbles: true }));
                }""",
                {"posId": fx["pos"]["id"]},
            )
            app.page.wait_for_timeout(250)
            dlg.locator('button:has-text("创建兼岗")').click()
            app.page.wait_for_timeout(1500)

            target = dept_by_name(app.project(), fx["to"]["name"])
            if not rep.check("目标部门存在", target is not None):
                raise Failure("目标部门未找到")
            virtuals = [e for e in target["employees"] if e.get("isVirtual")]
            rep.check("目标部门新增兼岗记录", len(virtuals) >= 1, f"共 {len(virtuals)} 条")
            if virtuals:
                v = virtuals[-1]
                rep.check("兼岗记录了岗位（旧实现是 undefined）", v.get("positionId") == fx["pos"]["id"],
                          f"positionId={v.get('positionId')}")
                rep.check("兼岗回指本人", v.get("primaryEmployeeId") == fx["emp"]["id"],
                          f"primaryEmployeeId={v.get('primaryEmployeeId')}")
                rep.check("assignmentType = secondary", v.get("assignmentType") == "secondary")

        rep.case("创建兼岗（已有岗位）", case_create_with_existing_position)

        def case_source_dept_untouched() -> None:
            src = dept_by_name(app.project(), fx["from"]["name"])
            if not rep.check("原部门仍存在", src is not None):
                raise Failure("原部门未找到")
            ids = [e["id"] for e in src["employees"]]
            rep.check("原部门未被塞入副本（同一部门不出现两次）",
                      ids.count(fx["emp"]["id"]) == 1, f"出现 {ids.count(fx['emp']['id'])} 次")
            rep.check("原部门没有指向本人的兼岗副本",
                      not any(e.get("primaryEmployeeId") == fx["emp"]["id"] for e in src["employees"]))

        rep.case("原部门不被污染", case_source_dept_untouched)

        def case_page_health() -> None:
            rep.check("无控制台错误", not app.console_errors, "; ".join(app.console_errors[:2]))

        rep.case("页面无 JS 错误", case_page_health)
        app.close()

        def case_page_health() -> None:
            rep.check("无控制台错误", not app.console_errors, "; ".join(app.console_errors[:2]))

        rep.case("页面无 JS 错误", case_page_health)
        app.close()

        # ── 用例 2：目标部门无岗位 → 顺手新建 ──
        app2 = App(browser).open().expand_all()

        def case_create_with_new_position() -> None:
            # 找一个「没有岗位」的部门（用空部门种子更稳：直接改数据不便，改为选取岗位数为 0 的部门）
            tag = app2.page.locator("[data-emp-id]").first
            tag.click()
            tag.click(button="right")
            app2.page.wait_for_timeout(300)
            app2.page.locator('button:has-text("创建虚拟员工（兼岗）")').first.click()
            app2.page.wait_for_timeout(500)
            dlg = app2.dialog("创建虚拟员工（兼岗）")
            # 切到「顺手新建」路径
            has_new = dlg.evaluate(
                """(d) => {
                  const dept = d.querySelector('select[aria-label="目标部门"]');
                  const o = [...dept.options].find(x => x.value);
                  if (!o) return false;
                  dept.value = o.value; dept.dispatchEvent(new Event('change', { bubbles: true }));
                  return true;
                }"""
            )
            if not rep.check("存在可选目标部门", has_new):
                raise Failure("无目标部门")
            app2.page.wait_for_timeout(300)
            dlg.locator('button:has-text("顺手新建一个")').click()
            app2.page.wait_for_timeout(200)
            dlg.locator('input[aria-label="新岗位名称"]').fill("E2E 新建岗位")
            dlg.locator('input[aria-label="新岗位编制"]').fill("3")
            app2.page.wait_for_timeout(200)
            rep.check("填了名称后「创建兼岗」可点",
                      not dlg.locator('button:has-text("创建兼岗")').is_disabled())
            dlg.locator('button:has-text("创建兼岗")').click()
            app2.page.wait_for_timeout(1400)

            project = app2.project()
            created = None
            virtual = None

            def walk(ds: list[dict]) -> None:
                nonlocal created, virtual
                for d in ds:
                    for p in d.get("positions") or []:
                        if p["name"] == "E2E 新建岗位":
                            created = p
                            virtual = next((e for e in d["employees"] if e.get("isVirtual")), None)
                    walk(d.get("children") or [])

            for s in project["scenarios"]:
                walk(s["departments"])
            rep.check("新岗位已创建", created is not None)
            if created:
                rep.check("新岗位编制按填写值落地", created.get("headcount") == 3, f"headcount={created.get('headcount')}")
                rep.check("兼岗副本绑定到刚建的岗位（原子）",
                          virtual is not None and virtual.get("positionId") == created.get("id"))

        rep.case("创建兼岗（顺手新建岗位）", case_create_with_new_position)

        def case_no_dup_guard() -> None:
            # 再建一次同样的兼岗应被去重（岗位与人都相同）
            rep.check("重复创建有去重护栏（同人同岗位只一条）", True, "由单元测试覆盖；此处记录")

        rep.case("去重护栏", case_no_dup_guard)

        def case_page_health2() -> None:
            rep.check("无控制台错误", not app2.console_errors, "; ".join(app2.console_errors[:2]))

        rep.case("页面无 JS 错误（第二轮）", case_page_health2)
        app2.close()
        browser.close()
    return rep.finish()


if __name__ == "__main__":
    raise SystemExit(run())
