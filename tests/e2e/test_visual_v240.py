#!/usr/bin/env python3
"""
V2.4.0 视觉回归测试。

原则：**截图不作为通过依据**（"好不好看"只能由人判），这里断言的全部是
**可计算的几何事实** —— 溢出、换行、对齐、等高、越界。截图只作为人工复核存档。

覆盖本版全部改动面：
  A 侧栏「文件上传」（模板下载挪入后的等高 / 不截断 / 不在 label 内）
  B 部门卡岗位行（编制输入框不随状态文案横向位移）
  C 虚拟员工弹窗（不出视口、无横向溢出）
  D 顶部菜单（两个旧入口已移除、按钮垂直居中对齐）
  E 「岗位与编制」页面级子界面（表格不溢出、同列对齐、行等高、双视图、窄窗口）
  F 全局（无横向滚动、无控制台错误）
  G 「无明确岗位」常驻提示位（在子界面宽度内、无溢出、文案完整）
  H 窄窗口回归
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import App, Report, load_seed, require_server  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SHOTS = str(Path(__file__).parent / "shots")
PAGE = '[data-page="position-board"]'


def run() -> int:
    require_server()
    rep = Report("V2.4.0 视觉回归（几何断言）")
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        app = App(browser, viewport=(1600, 1100), scale=2).open().expand_all()

        # ── A. 侧栏文件上传区 ──
        def case_sidebar() -> None:
            rows = app.page.evaluate(
                """() => [...document.querySelectorAll('.workspace-sidebar label')]
                     .filter(l => l.querySelector('input[type=file]'))
                     .map(l => ({ w: +l.getBoundingClientRect().width.toFixed(1),
                                  h: +l.getBoundingClientRect().height.toFixed(1),
                                  wrapped: l.scrollHeight > l.clientHeight + 1 }))"""
            )
            rep.check("两个上传行都在", len(rows) >= 2, f"共 {len(rows)} 行")
            if len(rows) >= 2:
                hs = {r["h"] for r in rows}
                rep.check("两行上传等高（不被模板按钮挤成不等高）", len(hs) == 1, f"高度={sorted(hs)}")
                rep.check("上传行都是单行", not any(r["wrapped"] for r in rows))
                rep.check("上传行宽度充足（≥180px）", min(r["w"] for r in rows) >= 180,
                          f"最窄={min(r['w'] for r in rows)}")

            tpl = app.page.evaluate(
                """() => [...document.querySelectorAll('.workspace-sidebar button')]
                     .filter(b => b.title && b.title.startsWith('下载「'))
                     .map(b => ({ t: b.textContent.trim(), h: +b.getBoundingClientRect().height.toFixed(1),
                                  truncated: b.scrollWidth > b.clientWidth + 1,
                                  inLabel: !!b.closest('label') }))"""
            )
            rep.check("两个模板下载按钮都在", len(tpl) == 2, f"共 {len(tpl)} 个")
            rep.check("模板按钮文字未被截断", not any(b["truncated"] for b in tpl))
            rep.check("模板按钮都是单行（高度 ≤ 36px）", all(b["h"] <= 36 for b in tpl),
                      f"高度={[b['h'] for b in tpl]}")
            rep.check("模板按钮不在 <label> 内（不会连带触发文件选择）",
                      not any(b["inLabel"] for b in tpl))
            app.screenshot(f"{SHOTS}/01-sidebar.png", ".workspace-sidebar")

        rep.case("A 侧栏「文件上传」几何", case_sidebar)

        # ── B. 岗位行：编制输入框不得随状态文案位移 ──
        def case_headcount_stability() -> None:
            boxes = app.page.evaluate(
                """() => [...document.querySelectorAll('[data-dept-id] input[type=number]')].map(i => {
                     const r = i.getBoundingClientRect();
                     const card = i.closest('[data-dept-id]');
                     return { x: +r.x.toFixed(1), card: card ? card.getAttribute('data-dept-id') : '?' };
                   })"""
            )
            rep.check("至少有一个岗位输入框", len(boxes) > 0, f"共 {len(boxes)} 个")
            by_card: dict[str, set[float]] = {}
            for b in boxes:
                by_card.setdefault(b["card"], set()).add(round(b["x"]))
            ragged = {c: sorted(xs) for c, xs in by_card.items() if len(xs) > 1}
            rep.check("同一张卡内的编制输入框对齐（±1px）", not ragged, f"不齐的卡={ragged}")

            seq = app.page.evaluate(
                """async () => {
                  const input = document.querySelector('[data-dept-id] input[type=number]');
                  const out = [];
                  for (const v of ['0','1','2','12','0']) {
                    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                    setter.call(input, v);
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    await new Promise(r => setTimeout(r, 220));
                    const r = input.getBoundingClientRect();
                    const row = input.closest('div.flex');
                    const status = row ? row.lastElementChild : null;
                    out.push({ v, x: +r.x.toFixed(1), status: status ? status.textContent.trim() : '' });
                  }
                  return out;
                }"""
            )
            xs2 = {s["x"] for s in seq}
            rep.check("编制在 0/1/2/12 间切换时输入框横向不动", len(xs2) == 1,
                      f"x 集合={sorted(xs2)} 状态={[s['status'] for s in seq]}")
            app.screenshot(f"{SHOTS}/02-headcount-rows.png", "[data-dept-id]")

        rep.case("B 岗位行编制输入框稳定性", case_headcount_stability)

        # ── C. 虚拟员工弹窗 ──
        def case_virtual_modal() -> None:
            tag = app.page.locator("[data-emp-id]").first
            tag.click()
            tag.click(button="right")
            app.page.wait_for_timeout(300)
            app.page.locator('button:has-text("创建虚拟员工（兼岗）")').first.click()
            app.page.wait_for_timeout(600)
            dlg = app.dialog("创建虚拟员工（兼岗）")
            if not rep.check("弹窗已打开", dlg.count() > 0):
                return
            box = dlg.bounding_box()
            vp = app.page.viewport_size
            rep.check("弹窗完整落在视口内",
                      box["x"] >= 0 and box["y"] >= 0
                      and box["x"] + box["width"] <= vp["width"] + 1
                      and box["y"] + box["height"] <= vp["height"] + 1,
                      f"box=({box['x']:.0f},{box['y']:.0f},{box['width']:.0f}x{box['height']:.0f})")
            overflow = dlg.evaluate(
                """(d) => [...d.querySelectorAll('*')]
                     .filter(e => e.scrollWidth > e.clientWidth + 2).length"""
            )
            rep.check("弹窗内无横向溢出元素", overflow == 0, f"溢出元素 {overflow} 个")
            app.screenshot(f"{SHOTS}/03-virtual-modal.png", '[role="dialog"]')
            dlg.locator('button:has-text("取消")').click()
            app.page.wait_for_timeout(400)

        rep.case("C 虚拟员工弹窗几何", case_virtual_modal)

        # ── D. 顶部菜单（V2.4.0：两行合并为一行）──
        def case_topbar() -> None:
            info = app.page.evaluate(
                """() => {
                  const h = document.querySelector('.workspace-header');
                  const kids = [...h.children].filter(c => c.getBoundingClientRect().height > 0);
                  const centers = kids.map(c => { const r = c.getBoundingClientRect(); return Math.round(r.y + r.height / 2); });
                  return {
                    headerH: Math.round(h.getBoundingClientRect().height),
                    spread: Math.max(...centers) - Math.min(...centers),
                    over: h.scrollWidth - h.clientWidth,
                    text: h.textContent,
                    hasLegacyBlocks: !!document.querySelector('.workspace-toolbar, .workspace-context'),
                  };
                }"""
            )
            rep.check("顶部栏已合并为单行（高度 ≤ 56px）", info["headerH"] <= 56, f"实测 {info['headerH']}px")
            rep.check("旧的第二行容器已移除（无 .workspace-toolbar / .workspace-context）",
                      not info["hasLegacyBlocks"])
            rep.check("顶部栏内容无横向溢出", info["over"] <= 1, f"超出 {info['over']}px")
            rep.check("全部簇垂直居中对齐（中线偏差 ≤2px）", info["spread"] <= 2, f"中线跨度={info['spread']}px")
            rep.check("不再显示写死的项目名", "组织架构项目" not in info["text"])
            rep.check("不再显示版本号徽标", not __import__("re").search(r"v\d+\.\d+\.\d+", info["text"]))
            rep.check("保存状态在同一行", "已保存" in info["text"] or "未保存" in info["text"])

            actions = app.page.evaluate(
                """() => [...document.querySelectorAll('.workspace-actions button')].map(b => {
                     const r = b.getBoundingClientRect();
                     return { t: b.textContent.trim(),
                              cy: +(r.y + r.height / 2).toFixed(1),
                              wrapped: b.scrollHeight > b.clientHeight + 1 };
                   })"""
            )
            names = [a["t"] for a in actions]
            rep.check("「工具模板」已移除", "工具模板" not in names, f"实际={names}")
            rep.check("「行业模板」已移除", "行业模板" not in names)
            rep.check("「缺口清单」已并入「岗位与编制」", "缺口清单" not in names, f"实际={names}")
            rep.check("高频入口仍在（岗位与编制/胜任度）",
                      all(n in names for n in ["岗位与编制", "胜任度"]), f"实际={names}")
            rep.check("顶部按钮未换行变形", not any(a["wrapped"] for a in actions))
            app.screenshot(f"{SHOTS}/04-topbar.png", ".workspace-header")

        rep.case("D 顶部菜单几何（单行）", case_topbar)

        # ── E. 「岗位与编制」页面级子界面 ──
        def case_board_page() -> None:
            app.page.click('button:has-text("岗位与编制")')
            app.page.wait_for_timeout(900)
            page = app.page.locator(PAGE)
            if not rep.check("子界面已挂载", page.count() == 1):
                return
            rep.check("是页面级子界面（无弹窗）", app.page.locator('[role="dialog"]').count() == 0)
            rep.check("画布已让位", app.page.locator(".workspace-canvas [data-dept-id]").count() == 0)

            box = page.bounding_box()
            vp = app.page.viewport_size
            rep.check("子界面在画布区内（不出视口）",
                      box["x"] >= 0 and box["width"] <= vp["width"] + 1,
                      f"x={box['x']:.0f} w={box['width']:.0f} vp={vp['width']}")

            over = app.page.evaluate(
                """() => {
                  const t = document.querySelector('[data-page="position-board"] table');
                  const wrap = t.closest('div');
                  return { table: t.scrollWidth - t.clientWidth, wrap: wrap.scrollWidth - wrap.clientWidth };
                }"""
            )
            rep.check("表格无横向溢出", over["table"] <= 1 and over["wrap"] <= 1, str(over))

            xs = app.page.evaluate(
                """() => [...document.querySelectorAll('[data-position-row] input[type=number]')]
                     .map(i => Math.round(i.getBoundingClientRect().x))"""
            )
            rep.check("编制输入框成列对齐", len(set(xs)) == 1, f"不同 x={sorted(set(xs))}")

            hs = app.page.evaluate(
                """() => [...document.querySelectorAll('[data-position-row]')]
                     .map(r => Math.round(r.getBoundingClientRect().height))"""
            )
            rep.check("岗位行等高", len(set(hs)) <= 1, f"高度集合={sorted(set(hs))}")

            tb = app.page.evaluate(
                """() => [...document.querySelectorAll('[data-page="position-board"] button')]
                     .filter(b => /按部门|按岗位|新增岗位|导出 Excel/.test(b.textContent))
                     .map(b => ({ t: b.textContent.trim(), wrapped: b.scrollHeight > b.clientHeight + 1 }))"""
            )
            rep.check("工具条按钮都是单行", not any(x["wrapped"] for x in tb), str(tb))
            app.screenshot(f"{SHOTS}/11-board-dept.png", PAGE)

            app.page.click('button:has-text("按岗位")')
            app.page.wait_for_timeout(500)
            merged = app.page.locator('[data-position-name-row]:has-text("分布在")')
            rep.check("存在跨部门同名岗位的聚合行（真实数据）", merged.count() > 0, f"{merged.count()} 行")
            app.screenshot(f"{SHOTS}/12-board-position.png", PAGE)
            app.page.click('button:has-text("按部门")')
            app.page.wait_for_timeout(400)

            app.page.set_viewport_size({"width": 900, "height": 900})
            app.page.wait_for_timeout(600)
            over2 = app.page.evaluate(
                "() => document.documentElement.scrollWidth - document.documentElement.clientWidth"
            )
            rep.check("900px 宽下子界面无横向溢出", over2 <= 1, f"超出 {over2}px")
            app.screenshot(f"{SHOTS}/13-board-narrow.png", PAGE)
            app.page.set_viewport_size({"width": 1600, "height": 1100})
            app.page.wait_for_timeout(500)
            app.page.click('button:has-text("返回画布")')
            app.page.wait_for_timeout(500)

        rep.case("E 岗位与编制子界面几何", case_board_page)

        # ── E2. 三个子页面的一致性（用户明确要求"跟岗位与编制一样"）──
        def case_subpage_consistency() -> None:
            geom: dict[str, dict] = {}
            for label, name in (("岗位与编制", "position-board"), ("健康度", "health"), ("胜任度", "competency")):
                app.page.click(f'.workspace-actions button:has-text("{label}")')
                app.page.wait_for_timeout(900)
                page = app.page.locator(f'[data-page="{name}"]')
                if not rep.check(f"「{label}」是子页面", page.count() == 1):
                    continue
                back = page.locator('button:has-text("返回画布")')
                g = app.page.evaluate(
                    """(name) => {
                      const p = document.querySelector(`[data-page="${name}"]`);
                      const back = p.querySelector('button');
                      const h1 = p.querySelector('h1');
                      const br = back.getBoundingClientRect(), hr = h1.getBoundingClientRect();
                      const pr = p.getBoundingClientRect();
                      return {
                        backX: Math.round(br.x), backY: Math.round(br.y),
                        backW: Math.round(br.width), backH: Math.round(br.height),
                        titleX: Math.round(hr.x), titleY: Math.round(hr.y),
                        titleSize: getComputedStyle(h1).fontSize,
                        pageX: Math.round(pr.x), pageW: Math.round(pr.width),
                        overflow: p.scrollWidth - p.clientWidth,
                        dialogs: document.querySelectorAll('[role="dialog"]').length,
                        canvas: document.querySelectorAll('.workspace-canvas [data-dept-id]').length,
                      };
                    }""",
                    name,
                )
                geom[name] = g
                rep.check(f"「{label}」标题字号一致 (18px)", g["titleSize"] == "18px", g["titleSize"])
                rep.check(f"「{label}」无弹窗", g["dialogs"] == 0, f"弹窗 {g['dialogs']} 个")
                rep.check(f"「{label}」打开时画布让位", g["canvas"] == 0, f"残留部门卡 {g['canvas']}")
                rep.check(f"「{label}」子页面无横向溢出", g["overflow"] <= 1, f"超出 {g['overflow']}px")
                app.screenshot(f"{SHOTS}/22-page-{name}.png", f'[data-page="{name}"]')
                app.page.click('button:has-text("返回画布")')
                app.page.wait_for_timeout(500)

            if len(geom) == 3:
                xs = {g["backX"] for g in geom.values()}
                ys = {g["backY"] for g in geom.values()}
                ws = {g["backW"] for g in geom.values()}
                rep.check("三个页面的「返回画布」在同一位置（x）", len(xs) == 1, f"x={sorted(xs)}")
                rep.check("三个页面的「返回画布」在同一位置（y）", len(ys) == 1, f"y={sorted(ys)}")
                rep.check("三个页面的「返回画布」同宽", len(ws) == 1, f"w={sorted(ws)}")
                tx = {g["titleX"] for g in geom.values()}
                rep.check("三个页面的标题起点对齐", len(tx) == 1, f"x={sorted(tx)}")
                ty = {g["titleY"] for g in geom.values()}
                rep.check("三个页面的标题基线对齐", len(ty) == 1, f"y={sorted(ty)}")
                pw = {g["pageW"] for g in geom.values()}
                rep.check("三个页面占满同一画布宽度", len(pw) == 1, f"w={sorted(pw)}")

            # 主页面不再有诊断横幅
            rep.check("主页面没有「人岗核对」横幅",
                      app.page.locator('button:has-text("人岗核对")').count() == 0)

        rep.case("E2 三个子页面一致性", case_subpage_consistency)

        # ── F. 全局 ──
        def case_global() -> None:
            rep.check("无控制台错误", not app.console_errors, "; ".join(app.console_errors[:2]))
            over = app.page.evaluate(
                "() => document.documentElement.scrollWidth - document.documentElement.clientWidth"
            )
            rep.check("页面无横向滚动", over <= 1, f"超出 {over}px")

        rep.case("F 全局", case_global)
        app.close()

        # ── G. 「无明确岗位」常驻提示位（用派生种子，不改动真实数据）──
        def case_positionless_banner() -> None:
            seed = json.loads(load_seed())
            sc = next(x for x in seed["scenarios"] if x["id"] == seed["currentScenarioId"])
            victims: list[dict] = []

            def collect(ds: list[dict]) -> None:
                for d in ds:
                    for e in d["employees"]:
                        if not e.get("isVirtual"):
                            victims.append(e)
                    collect(d.get("children") or [])

            collect(sc["departments"])
            if not rep.check("种子里有 ≥2 名员工可用于构造提示位", len(victims) >= 2):
                return
            victims[0]["positionId"] = "deleted-position-xxx"
            victims[1]["positionId"] = None
            for e in sc.get("allEmployeesFlat") or []:
                for v in victims[:2]:
                    if e["id"] == v["id"]:
                        e["positionId"] = v["positionId"]

            app2 = App(browser, seed=seed, viewport=(1500, 1000), scale=2).open(1800)
            app2.page.click('button:has-text("岗位与编制")')
            app2.page.wait_for_timeout(900)
            banner = app2.page.locator("[data-positionless-banner]")
            if not rep.check("提示位出现", banner.count() == 1):
                app2.close()
                return
            b = banner.bounding_box()
            page_box = app2.page.locator(PAGE).bounding_box()
            rep.check("提示位在子界面宽度内",
                      b["x"] >= page_box["x"] - 1 and b["x"] + b["width"] <= page_box["x"] + page_box["width"] + 1,
                      f"banner={b['width']:.0f} page={page_box['width']:.0f}")
            rep.check("提示位内无横向溢出", banner.evaluate("(e) => e.scrollWidth - e.clientWidth") <= 1)
            txt = banner.inner_text()
            rep.check("文案写明人数", "名员工处于无明确岗位状态" in txt)
            rep.check("文案区分两种原因", "岗位已删除" in txt and "未套岗" in txt)
            rep.check("文案给出处置建议", "建议" in txt)
            app2.screenshot(f"{SHOTS}/14-positionless-banner.png", PAGE)
            app2.close()

        rep.case("G 「无明确岗位」提示位几何", case_positionless_banner)

        # ── H. 窄窗口回归 ──
        for w in (900, 560):
            app3 = App(browser, viewport=(w, 900)).open(1800)

            def case_narrow(win: int = w, a: App = app3) -> None:
                over = a.page.evaluate(
                    "() => document.documentElement.scrollWidth - document.documentElement.clientWidth"
                )
                rep.check(f"{win}px 宽下无横向溢出", over <= 1, f"超出 {over}px")
                a.screenshot(f"{SHOTS}/05-narrow-{win}.png")

            rep.case(f"H 窄窗口 {w}px", case_narrow)
            app3.close()

        # ── I. 部门删除 / 归属限制的界面几何 ──
        def case_dept_rules() -> None:
            app4 = App(browser, viewport=(1600, 1050), scale=2).open().expand_all()

            # 新建部门表单：层级提示必须可见且不溢出
            app4.page.click('button:has-text("新建部门")')
            app4.page.wait_for_timeout(500)
            hint = app4.page.locator("[data-dept-parent-hint]")
            if rep.check("新建部门表单出现层级提示", hint.count() == 1):
                rep.check("提示文案无横向溢出",
                          hint.evaluate("(e) => e.scrollWidth - e.clientWidth") <= 1)
                rep.check("提示文案写明规则",
                          "归属" in hint.inner_text())
            form = app4.page.locator("select[aria-label='归属部门']")
            form_box = form.bounding_box()
            sidebar_box = app4.page.locator(".workspace-sidebar").bounding_box()
            rep.check("归属下拉不超出侧栏宽度",
                      form_box["x"] + form_box["width"] <= sidebar_box["x"] + sidebar_box["width"] + 1,
                      f"下拉右边界={form_box['x'] + form_box['width']:.0f} 侧栏右边界={sidebar_box['x'] + sidebar_box['width']:.0f}")

            # 建一个空部门再走删除确认
            app4.page.locator('select[aria-label="部门层级"]').select_option("1")
            app4.page.locator('input[aria-label="部门名称"]').fill("视觉回归空部门")
            app4.page.click('button:has-text("创建")')
            app4.page.wait_for_timeout(1000)
            created = app4.page.evaluate(
                """() => {
                  const cards = [...document.querySelectorAll('[data-dept-id]')];
                  const hit = cards.find(c => c.textContent.includes('视觉回归空部门'));
                  return hit ? hit.getAttribute('data-dept-id') : null;
                }"""
            )
            if rep.check("空部门已建出", created is not None):
                app4.page.locator(f'[data-dept-id="{created}"] [data-dept-header]').first.click(button="right")
                app4.page.wait_for_timeout(350)
                menu = app4.page.locator("[data-dept-delete]")
                rep.check("菜单项可见且不溢出",
                          menu.count() == 1 and menu.first.evaluate("(e) => e.scrollWidth - e.clientWidth") <= 1)
                app4.screenshot(f"{SHOTS}/15-dept-menu.png")
                menu.first.click()
                app4.page.wait_for_timeout(600)
                dlg = app4.page.locator('[role="dialog"]').filter(has_text="确认删除部门")
                if rep.check("删除确认弹窗出现", dlg.count() >= 1):
                    box = dlg.first.bounding_box()
                    vp = app4.page.viewport_size
                    rep.check("确认弹窗完整落在视口内",
                              box["x"] >= 0 and box["x"] + box["width"] <= vp["width"] + 1
                              and box["y"] + box["height"] <= vp["height"] + 1)
                    rep.check("确认弹窗内无横向溢出",
                              dlg.first.evaluate(
                                  "(d) => [...d.querySelectorAll('*')].filter(e => e.scrollWidth > e.clientWidth + 2).length") == 0)
                    app4.screenshot(f"{SHOTS}/16-dept-delete-confirm.png", '[role="dialog"]')
                    dlg.first.locator('button:has-text("取消")').click()
                app4.page.wait_for_timeout(400)

            # 有员工的部门 → 阻塞说明弹窗
            busy = app4.page.evaluate(
                """() => {
                  const cards = [...document.querySelectorAll('[data-dept-id]')];
                  const hit = cards.find(c => c.querySelector('[data-emp-id]'));
                  return hit ? hit.getAttribute('data-dept-id') : null;
                }"""
            )
            if rep.check("找到含员工的部门", busy is not None):
                app4.page.locator(f'[data-dept-id="{busy}"] [data-dept-header]').first.click(button="right")
                app4.page.wait_for_timeout(350)
                app4.page.locator("[data-dept-delete]").first.click()
                app4.page.wait_for_timeout(600)
                block = app4.page.locator('[role="dialog"]').filter(has_text="无法删除部门")
                if rep.check("阻塞说明弹窗出现", block.count() >= 1):
                    box = block.first.bounding_box()
                    rep.check("说明弹窗完整落在视口内",
                              box["x"] >= 0 and box["x"] + box["width"] <= app4.page.viewport_size["width"] + 1)
                    rep.check("说明弹窗内无横向溢出",
                              block.first.evaluate(
                                  "(d) => [...d.querySelectorAll('*')].filter(e => e.scrollWidth > e.clientWidth + 2).length") == 0)
                    rep.check("说明写明先挪人", "请先把他们挪到其他部门" in block.first.inner_text())
                    app4.screenshot(f"{SHOTS}/17-dept-delete-blocked.png", '[role="dialog"]')
                    block.first.locator('button:has-text("知道了")').click()
            app4.close()

        rep.case("I 部门删除 / 归属限制界面几何", case_dept_rules)

        browser.close()
    print(f"\n截图存档：{os.path.relpath(SHOTS)}")
    return rep.finish()


if __name__ == "__main__":
    raise SystemExit(run())
